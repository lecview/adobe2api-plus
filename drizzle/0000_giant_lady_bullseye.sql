CREATE TABLE `adminsession` (
	`id` varchar(191) NOT NULL,
	`tokenHash` char(64) NOT NULL,
	`userId` varchar(191) NOT NULL,
	`expiresAt` datetime(3) NOT NULL,
	`revokedAt` datetime(3),
	`createdAt` datetime(3) NOT NULL,
	`lastSeenAt` datetime(3),
	CONSTRAINT `adminsession_id` PRIMARY KEY(`id`),
	CONSTRAINT `AdminSession_tokenHash_key` UNIQUE(`tokenHash`)
);
--> statement-breakpoint
CREATE TABLE `adminuser` (
	`id` varchar(191) NOT NULL,
	`username` varchar(128) NOT NULL,
	`passwordHash` varchar(255) NOT NULL,
	`status` enum('ACTIVE','DISABLED') NOT NULL DEFAULT 'ACTIVE',
	`lastLoginAt` datetime(3),
	`createdAt` datetime(3) NOT NULL,
	`updatedAt` datetime(3) NOT NULL,
	CONSTRAINT `adminuser_id` PRIMARY KEY(`id`),
	CONSTRAINT `AdminUser_username_key` UNIQUE(`username`)
);
--> statement-breakpoint
CREATE TABLE `adobeaccount` (
	`id` varchar(191) NOT NULL,
	`externalId` varchar(255),
	`displayName` varchar(255) NOT NULL,
	`email` varchar(255),
	`status` enum('AVAILABLE','UNAVAILABLE','REFRESHING') NOT NULL DEFAULT 'AVAILABLE',
	`lastRefreshAt` datetime(3),
	`lastRefreshError` text,
	`createdAt` datetime(3) NOT NULL,
	`updatedAt` datetime(3) NOT NULL,
	CONSTRAINT `adobeaccount_id` PRIMARY KEY(`id`),
	CONSTRAINT `AdobeAccount_externalId_key` UNIQUE(`externalId`)
);
--> statement-breakpoint
CREATE TABLE `adobetoken` (
	`id` varchar(191) NOT NULL,
	`accountId` varchar(191) NOT NULL,
	`encryptedAccessToken` text NOT NULL,
	`expiresAt` datetime(3),
	`status` enum('ACTIVE','DISABLED','EXHAUSTED','INVALID','EXPIRED','REVOKED') NOT NULL DEFAULT 'ACTIVE',
	`source` varchar(32) NOT NULL DEFAULT 'manual',
	`autoRefreshEnabled` boolean NOT NULL DEFAULT false,
	`refreshProfileId` varchar(191),
	`failureCount` int NOT NULL DEFAULT 0,
	`errorUntil` datetime(3),
	`lastError` text,
	`creditsTotal` double,
	`creditsUsed` double,
	`creditsAvailable` double,
	`creditsAvailableUntil` varchar(64),
	`creditsUpdatedAt` datetime(3),
	`creditsError` text,
	`lastUsedAt` datetime(3),
	`createdAt` datetime(3) NOT NULL,
	`updatedAt` datetime(3) NOT NULL,
	CONSTRAINT `adobetoken_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `entity` (
	`id` varchar(191) NOT NULL,
	`accountId` varchar(191) NOT NULL,
	`name` varchar(128) NOT NULL,
	`entityType` varchar(64) NOT NULL,
	`description` text,
	`upstreamId` varchar(255),
	`metadata` json,
	`status` enum('ACTIVE','DISABLED','DELETED') NOT NULL DEFAULT 'ACTIVE',
	`createdAt` datetime(3) NOT NULL,
	`updatedAt` datetime(3) NOT NULL,
	CONSTRAINT `entity_id` PRIMARY KEY(`id`),
	CONSTRAINT `Entity_accountId_name_key` UNIQUE(`accountId`,`name`)
);
--> statement-breakpoint
CREATE TABLE `generationjob` (
	`id` varchar(191) NOT NULL,
	`kind` enum('GENERATION','ENTITY_CREATE','ENTITY_SYNC','ENTITY_DELETE','REFRESH') NOT NULL DEFAULT 'GENERATION',
	`status` enum('QUEUED','UPLOADING','SUBMITTING','POLLING','DOWNLOADING','SUCCEEDED','FAILED','CANCELLED','SUBMISSION_UNKNOWN') NOT NULL DEFAULT 'QUEUED',
	`apiPath` varchar(255) NOT NULL,
	`model` varchar(128),
	`requestPayload` json NOT NULL,
	`resultPayload` json,
	`errorCode` varchar(128),
	`errorMessage` text,
	`upstreamTaskId` varchar(255),
	`upstreamPollUrl` text,
	`adobeAccountId` varchar(191),
	`accountSnapshot` json,
	`currentProxyId` varchar(191),
	`proxySnapshot` json,
	`proxyAttemptIndex` int,
	`leaseOwner` varchar(128),
	`leaseExpiresAt` datetime(3),
	`attemptCount` int NOT NULL DEFAULT 0,
	`startedAt` datetime(3),
	`completedAt` datetime(3),
	`lastHeartbeatAt` datetime(3),
	`entityId` varchar(191),
	`createdAt` datetime(3) NOT NULL,
	`updatedAt` datetime(3) NOT NULL,
	CONSTRAINT `generationjob_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `jobattempt` (
	`id` varchar(191) NOT NULL,
	`jobId` varchar(191) NOT NULL,
	`stage` enum('UPLOAD','SUBMIT','POLL','DOWNLOAD','REFRESH') NOT NULL,
	`attemptNumber` int NOT NULL,
	`proxyId` varchar(191),
	`status` enum('RUNNING','SUCCEEDED','FAILED','SKIPPED') NOT NULL DEFAULT 'RUNNING',
	`errorCategory` varchar(128),
	`errorMessage` text,
	`upstreamStatus` int,
	`metadata` json,
	`startedAt` datetime(3) NOT NULL,
	`finishedAt` datetime(3),
	CONSTRAINT `jobattempt_id` PRIMARY KEY(`id`),
	CONSTRAINT `JobAttempt_jobId_stage_attemptNumber_key` UNIQUE(`jobId`,`stage`,`attemptNumber`)
);
--> statement-breakpoint
CREATE TABLE `jobevent` (
	`id` varchar(191) NOT NULL,
	`jobId` varchar(191) NOT NULL,
	`sequence` int NOT NULL,
	`type` varchar(64) NOT NULL,
	`payload` json,
	`createdAt` datetime(3) NOT NULL,
	CONSTRAINT `jobevent_id` PRIMARY KEY(`id`),
	CONSTRAINT `JobEvent_jobId_sequence_key` UNIQUE(`jobId`,`sequence`)
);
--> statement-breakpoint
CREATE TABLE `loginthrottle` (
	`keyHash` char(64) NOT NULL,
	`windowStartedAt` datetime(3) NOT NULL,
	`attempts` int NOT NULL DEFAULT 0,
	`blockedUntil` datetime(3),
	`createdAt` datetime(3) NOT NULL,
	`updatedAt` datetime(3) NOT NULL,
	CONSTRAINT `loginthrottle_keyHash` PRIMARY KEY(`keyHash`)
);
--> statement-breakpoint
CREATE TABLE `mediaasset` (
	`id` varchar(191) NOT NULL,
	`jobId` varchar(191) NOT NULL,
	`objectKey` varchar(500) NOT NULL,
	`mimeType` varchar(128) NOT NULL,
	`byteSize` bigint NOT NULL,
	`sha256` char(64) NOT NULL,
	`status` enum('READY','EXPIRED','DELETED') NOT NULL DEFAULT 'READY',
	`expiresAt` datetime(3),
	`createdAt` datetime(3) NOT NULL,
	CONSTRAINT `mediaasset_id` PRIMARY KEY(`id`),
	CONSTRAINT `MediaAsset_objectKey_key` UNIQUE(`objectKey`)
);
--> statement-breakpoint
CREATE TABLE `proxynode` (
	`id` varchar(191) NOT NULL,
	`protocol` enum('HTTP','SOCKS5') NOT NULL,
	`host` varchar(255) NOT NULL,
	`port` int NOT NULL,
	`encryptedUsername` text,
	`encryptedPassword` text,
	`enabled` boolean NOT NULL DEFAULT true,
	`displayOrder` int NOT NULL,
	`version` int NOT NULL DEFAULT 1,
	`createdAt` datetime(3) NOT NULL,
	`updatedAt` datetime(3) NOT NULL,
	CONSTRAINT `proxynode_id` PRIMARY KEY(`id`),
	CONSTRAINT `ProxyNode_displayOrder_key` UNIQUE(`displayOrder`)
);
--> statement-breakpoint
CREATE TABLE `proxyrotationstate` (
	`id` varchar(191) NOT NULL DEFAULT 'singleton',
	`nextOrder` int NOT NULL DEFAULT 0,
	`version` int NOT NULL DEFAULT 1,
	`updatedAt` datetime(3) NOT NULL,
	CONSTRAINT `proxyrotationstate_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `refreshprofile` (
	`id` varchar(191) NOT NULL,
	`accountId` varchar(191) NOT NULL,
	`name` varchar(255),
	`encryptedCookie` text NOT NULL,
	`externalAccountId` varchar(255),
	`status` enum('ACTIVE','INVALID','DISABLED') NOT NULL DEFAULT 'ACTIVE',
	`enabled` boolean NOT NULL DEFAULT true,
	`nextRefreshAt` datetime(3),
	`lastAttemptAt` datetime(3),
	`lastSuccessAt` datetime(3),
	`consecutiveFailures` int NOT NULL DEFAULT 0,
	`lastHttpStatus` int,
	`leaseOwner` varchar(128),
	`leaseExpiresAt` datetime(3),
	`lastError` text,
	`createdAt` datetime(3) NOT NULL,
	`updatedAt` datetime(3) NOT NULL,
	CONSTRAINT `refreshprofile_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `serviceapikey` (
	`id` varchar(191) NOT NULL,
	`name` varchar(128) NOT NULL,
	`keyHash` char(64) NOT NULL,
	`prefix` varchar(16) NOT NULL,
	`active` boolean NOT NULL DEFAULT true,
	`createdAt` datetime(3) NOT NULL,
	`revokedAt` datetime(3),
	`lastUsedAt` datetime(3),
	CONSTRAINT `serviceapikey_id` PRIMARY KEY(`id`),
	CONSTRAINT `ServiceApiKey_keyHash_key` UNIQUE(`keyHash`)
);
--> statement-breakpoint
CREATE TABLE `systemsetting` (
	`id` varchar(191) NOT NULL DEFAULT 'singleton',
	`proxyEnabled` boolean NOT NULL DEFAULT false,
	`mediaRoot` varchar(500) NOT NULL DEFAULT './data/generated',
	`mediaRetention` json,
	`publicModels` json,
	`publicBaseUrl` varchar(500),
	`adobeBaseUrl` varchar(500),
	`generateTimeoutSeconds` int NOT NULL DEFAULT 300,
	`videoGenerateTimeoutSeconds` int NOT NULL DEFAULT 600,
	`refreshIntervalHours` int NOT NULL DEFAULT 15,
	`retryEnabled` boolean NOT NULL DEFAULT true,
	`retryMaxAttempts` int NOT NULL DEFAULT 3,
	`retryBackoffMs` int NOT NULL DEFAULT 1000,
	`retryOnStatusCodes` json,
	`retryOnErrorTypes` json,
	`tokenRotationStrategy` varchar(32) NOT NULL DEFAULT 'round_robin',
	`batchConcurrency` int NOT NULL DEFAULT 5,
	`creditsRefreshConcurrency` int NOT NULL DEFAULT 1,
	`accountMaxConcurrency` int NOT NULL DEFAULT 1,
	`generatedMaxSizeMb` int NOT NULL DEFAULT 1024,
	`generatedPruneSizeMb` int NOT NULL DEFAULT 200,
	`mediaRetentionDays` int NOT NULL DEFAULT 30,
	`adobeTimeoutMs` int NOT NULL DEFAULT 60000,
	`adobeGenerateTimeoutMs` int NOT NULL DEFAULT 300000,
	`adobePollMs` int NOT NULL DEFAULT 3000,
	`workerPollMs` int NOT NULL DEFAULT 1000,
	`jobLeaseMs` int NOT NULL DEFAULT 30000,
	`syncTimeoutMs` int NOT NULL DEFAULT 120000,
	`cleanupLeaseOwner` varchar(128),
	`cleanupLeaseExpiresAt` datetime(3),
	`updatedAt` datetime(3) NOT NULL,
	CONSTRAINT `systemsetting_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `AdminSession_userId_revokedAt_expiresAt_idx` ON `adminsession` (`userId`,`revokedAt`,`expiresAt`);--> statement-breakpoint
CREATE INDEX `AdobeToken_accountId_status_expiresAt_idx` ON `adobetoken` (`accountId`,`status`,`expiresAt`);--> statement-breakpoint
CREATE INDEX `AdobeToken_refreshProfileId_autoRefreshEnabled_idx` ON `adobetoken` (`refreshProfileId`,`autoRefreshEnabled`);--> statement-breakpoint
CREATE INDEX `Entity_name_status_idx` ON `entity` (`name`,`status`);--> statement-breakpoint
CREATE INDEX `GenerationJob_status_leaseExpiresAt_createdAt_idx` ON `generationjob` (`status`,`leaseExpiresAt`,`createdAt`);--> statement-breakpoint
CREATE INDEX `GenerationJob_createdAt_idx` ON `generationjob` (`createdAt`);--> statement-breakpoint
CREATE INDEX `GenerationJob_adobeAccountId_status_idx` ON `generationjob` (`adobeAccountId`,`status`);--> statement-breakpoint
CREATE INDEX `GenerationJob_entityId_fkey` ON `generationjob` (`entityId`);--> statement-breakpoint
CREATE INDEX `JobAttempt_jobId_startedAt_idx` ON `jobattempt` (`jobId`,`startedAt`);--> statement-breakpoint
CREATE INDEX `JobAttempt_proxyId_status_idx` ON `jobattempt` (`proxyId`,`status`);--> statement-breakpoint
CREATE INDEX `JobEvent_jobId_createdAt_idx` ON `jobevent` (`jobId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `LoginThrottle_blockedUntil_idx` ON `loginthrottle` (`blockedUntil`);--> statement-breakpoint
CREATE INDEX `LoginThrottle_updatedAt_idx` ON `loginthrottle` (`updatedAt`);--> statement-breakpoint
CREATE INDEX `MediaAsset_jobId_status_idx` ON `mediaasset` (`jobId`,`status`);--> statement-breakpoint
CREATE INDEX `MediaAsset_expiresAt_status_idx` ON `mediaasset` (`expiresAt`,`status`);--> statement-breakpoint
CREATE INDEX `ProxyNode_enabled_displayOrder_idx` ON `proxynode` (`enabled`,`displayOrder`);--> statement-breakpoint
CREATE INDEX `RefreshProfile_accountId_status_idx` ON `refreshprofile` (`accountId`,`status`);--> statement-breakpoint
CREATE INDEX `RefreshProfile_status_nextRefreshAt_leaseExpiresAt_idx` ON `refreshprofile` (`status`,`nextRefreshAt`,`leaseExpiresAt`);