-- Enum additions must commit before PostgreSQL permits their use.
ALTER TYPE "CreatorSearchPartitionStatus" ADD VALUE IF NOT EXISTS 'EXPERIMENT_ONLY';
ALTER TYPE "CreatorSchedulerClass" ADD VALUE IF NOT EXISTS 'EXPERIMENT_ONLY';
