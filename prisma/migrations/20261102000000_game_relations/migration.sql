-- Additive migration: existing works, ownership, profiles and sessions are unchanged.
CREATE TABLE "GameRelation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "sourceGameId" TEXT NOT NULL,
    "targetGameId" TEXT NOT NULL,
    "type" TEXT NOT NULL CHECK ("type" IN ('REMAKE_OF', 'REMASTER_OF')),
    "note" TEXT NOT NULL,
    "revision" INTEGER NOT NULL CHECK ("revision" > 0),
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CHECK ("sourceGameId" <> "targetGameId"),
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    FOREIGN KEY ("sourceGameId") REFERENCES "Game"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    FOREIGN KEY ("targetGameId") REFERENCES "Game"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "GameRelation_userId_sourceGameId_targetGameId_key" ON "GameRelation"("userId", "sourceGameId", "targetGameId");
CREATE INDEX "GameRelation_userId_targetGameId_idx" ON "GameRelation"("userId", "targetGameId");

CREATE TABLE "GameRelationEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "relationId" TEXT NOT NULL,
    "sourceGameId" TEXT NOT NULL,
    "targetGameId" TEXT NOT NULL,
    "action" TEXT NOT NULL CHECK ("action" IN ('CREATE', 'UPDATE', 'DELETE')),
    "type" TEXT NOT NULL CHECK ("type" IN ('REMAKE_OF', 'REMASTER_OF')),
    "note" TEXT NOT NULL,
    "revision" INTEGER NOT NULL CHECK ("revision" > 0),
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK ("sourceGameId" <> "targetGameId"),
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    FOREIGN KEY ("sourceGameId") REFERENCES "Game"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    FOREIGN KEY ("targetGameId") REFERENCES "Game"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "GameRelationEvent_userId_relationId_revision_key" ON "GameRelationEvent"("userId", "relationId", "revision");
CREATE INDEX "GameRelationEvent_userId_sourceGameId_createdAt_idx" ON "GameRelationEvent"("userId", "sourceGameId", "createdAt");
CREATE INDEX "GameRelationEvent_userId_targetGameId_createdAt_idx" ON "GameRelationEvent"("userId", "targetGameId", "createdAt");
