ALTER TABLE `systemsetting` MODIFY COLUMN `minCreditsThreshold` int NOT NULL DEFAULT 100;--> statement-breakpoint
ALTER TABLE `systemsetting` MODIFY COLUMN `workerConcurrency` int NOT NULL DEFAULT 5;--> statement-breakpoint
ALTER TABLE `systemsetting` MODIFY COLUMN `accountMaxConcurrency` int NOT NULL DEFAULT 3;