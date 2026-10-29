import { Global, Module } from '@nestjs/common';
import { DeadlinesService } from '../jobs/deadlines.service';
import { QueueService } from '../jobs/queue.service';
import { DeliveryService } from './delivery.service';
import { InboxService } from './inbox.service';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { PushService } from './push.service';

/** Notifications, their email/SMS delivery, and the deadline jobs that raise reminders and overdue alerts. */
@Global()
@Module({
  controllers: [NotificationsController],
  providers: [NotificationsService, DeliveryService, InboxService, QueueService, DeadlinesService, PushService],
  exports: [NotificationsService, DeadlinesService, DeliveryService],
})
export class NotificationsModule {}
