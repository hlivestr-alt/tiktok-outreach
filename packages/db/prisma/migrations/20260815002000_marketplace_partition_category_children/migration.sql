ALTER TABLE "CreatorMarketplaceCategory"
  ADD COLUMN "availableForCreatorFilter" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "CreatorSearchPartition"
  ADD COLUMN "categoryChildIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

UPDATE "CreatorSearchPartition" AS partition
SET "categoryChildIds" = snapshot.child_ids
FROM (
  SELECT
    candidate.id,
    array_agg(category."categoryId" ORDER BY category."sortOrder", category."categoryId") AS child_ids
  FROM "CreatorSearchPartition" AS candidate
  JOIN "CreatorSyncJob" AS job
    ON job.id = candidate."creatorSyncJobId"
  JOIN "CreatorMarketplaceCategory" AS category
    ON category."shopId" = job."shopId"
   AND category."parentCategoryId" = candidate."categoryId"
   AND category."availableForCreatorFilter" = true
  WHERE candidate."followerBucket" IS NOT NULL
    AND candidate."pagesCompleted" = 0
    AND candidate."privateSearchKey" IS NULL
    AND candidate."privateNextPageToken" IS NULL
  GROUP BY candidate.id
) AS snapshot
WHERE partition.id = snapshot.id
  AND cardinality(partition."categoryChildIds") = 0;
