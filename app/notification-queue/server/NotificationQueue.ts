import { Meteor } from 'meteor/meteor';

import { INotification, INotificationItemPush, INotificationItemEmail, NotificationItem } from '../../../definition/INotification';
import { NotificationQueue, Users } from '../../models/server/raw';
import { sendEmailFromData } from '../../lib/server/functions/notifications/email';
import { PushNotification } from '../../push-notifications/server';

class NotificationClass {
	private running = false;

	private cyclePause = 2000;

	private maxBatchSize = 100;

	private maxScheduleDelaySeconds = 120

	initWorker(): void {
		this.running = true;
		this.executeWorkerLater();
	}

	stopWorker(): void {
		this.running = false;
	}

	executeWorkerLater(): void {
		if (!this.running) {
			return;
		}

		setTimeout(this.worker.bind(this), this.cyclePause);
	}

	async worker(counter = 0): Promise<void> {
		const notification = await this.getNextNotification();

		if (!notification) {
			return this.executeWorkerLater();
		}

		// Once we start notifying the user we anticipate all the schedules
		const flush = await NotificationQueue.clearScheduleByUserId(notification.uid);

		// start worker again it queue flushed
		if (flush.modifiedCount) {
			await NotificationQueue.unsetSendingById(notification._id);
			return this.worker(counter);
		}

		console.log('processing', notification._id);

		try {
			for (const item of notification.items) {
				switch (item.type) {
					case 'push':
						this.push(notification, item);
						break;
					case 'email':
						this.email(item);
						break;
				}
			}

			NotificationQueue.removeById(notification._id);
		} catch (e) {
			console.error(e);
			await NotificationQueue.unsetSendingById(notification._id);
		}

		if (counter >= this.maxBatchSize) {
			return this.executeWorkerLater();
		}
		this.worker(counter++);
	}

	getNextNotification(): Promise<INotification | undefined> {
		const expired = new Date();
		expired.setMinutes(expired.getMinutes() - 5);

		return NotificationQueue.findNextInQueueOrExpired(expired);
	}

	push({ uid, rid, mid }: INotification, item: INotificationItemPush): void {
		PushNotification.send({
			rid,
			uid,
			mid,
			...item.data,
		});
	}

	email(item: INotificationItemEmail): void {
		sendEmailFromData(item.data);
	}

	async scheduleItem({ uid, rid, sid, mid, items }: {uid: string; rid: string; sid: string; mid: string; items: NotificationItem[]}): Promise<void> {
		const user = await Users.findOneById(uid, {
			projection: {
				statusConnection: 1,
				_updatedAt: 1,
			},
		});

		if (!user) {
			return;
		}

		const delay = this.maxScheduleDelaySeconds;

		let schedule: Date | undefined;

		if (user.statusConnection === 'online') {
			schedule = new Date();
			schedule.setSeconds(schedule.getSeconds() + delay);
		} else if (user.statusConnection === 'away') {
			const elapsedSeconds = Math.floor((Date.now() - user._updatedAt) / 1000);
			if (elapsedSeconds < delay) {
				schedule = new Date();
				schedule.setSeconds(schedule.getSeconds() + delay - elapsedSeconds);
			}
		}

		await NotificationQueue.insertOne({
			uid,
			rid,
			sid,
			mid,
			ts: new Date(),
			schedule,
			items,
		});
	}
}

export const Notification = new NotificationClass();

Meteor.startup(() => {
	Notification.initWorker();
});