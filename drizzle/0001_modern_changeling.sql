ALTER TABLE `systemsetting` MODIFY COLUMN `refreshIntervalHours` int NOT NULL DEFAULT 25;--> statement-breakpoint
ALTER TABLE `adobeaccount` ADD `riskFlagged` boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `adobeaccount` ADD `riskFlaggedAt` datetime(3);--> statement-breakpoint
ALTER TABLE `adobeaccount` ADD `riskFlaggedReason` text;--> statement-breakpoint
ALTER TABLE `mediaasset` ADD `url` varchar(1000);--> statement-breakpoint
ALTER TABLE `refreshprofile` ADD `sherlockToken` text;--> statement-breakpoint
ALTER TABLE `refreshprofile` ADD `sherlockExpiresAt` datetime(3);--> statement-breakpoint
ALTER TABLE `refreshprofile` ADD `sherlockSource` varchar(16);--> statement-breakpoint
ALTER TABLE `refreshprofile` ADD `sherlockUpdatedAt` datetime(3);--> statement-breakpoint
ALTER TABLE `systemsetting` ADD `sherlockRefreshMinutes` int DEFAULT 5 NOT NULL;--> statement-breakpoint
ALTER TABLE `systemsetting` ADD `sherlockAutoRefreshEnabled` boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `systemsetting` ADD `minCreditsThreshold` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `systemsetting` ADD `returnOriginalUrl` boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `systemsetting` ADD `workerConcurrency` int DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `systemsetting` ADD `sherlockToken` text;--> statement-breakpoint
ALTER TABLE `systemsetting` ADD `sherlockExpiresAt` datetime(3);--> statement-breakpoint
ALTER TABLE `systemsetting` ADD `sherlockSource` varchar(16);--> statement-breakpoint
ALTER TABLE `systemsetting` ADD `sherlockUpdatedAt` datetime(3);