-- Copy the metadata displayed by 0.1.6. Preserve legacy manual locks, but do
-- not invent historical events, provider identities or candidate values.
CREATE TABLE "UserGameMetadata" (
    "profileId" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "originalTitle" TEXT NOT NULL,
    "localizedTitle" TEXT NOT NULL,
    "developer" TEXT NOT NULL,
    "publisher" TEXT NOT NULL,
    "genre" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "coverUrl" TEXT NOT NULL,
    "searchText" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "rawgAttributed" BOOLEAN NOT NULL DEFAULT false,
    FOREIGN KEY ("profileId") REFERENCES "UserGameProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "UserGameMetadata_genre_idx" ON "UserGameMetadata"("genre");
CREATE INDEX "UserGameMetadata_title_idx" ON "UserGameMetadata"("title");
CREATE INDEX "UserGameMetadata_updatedAt_idx" ON "UserGameMetadata"("updatedAt");

INSERT INTO "UserGameMetadata" ("profileId", "title", "originalTitle", "localizedTitle", "developer", "publisher", "genre", "description", "coverUrl", "searchText", "updatedAt")
SELECT p."id", g."title", g."originalTitle", g."localizedTitle", g."developer", g."publisher", g."genre", g."description", g."coverUrl", g."searchText", g."updatedAt"
FROM "UserGameProfile" p JOIN "Game" g ON g."id" = p."gameId";

CREATE TABLE "ProfileFieldHistory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "profileId" TEXT NOT NULL,
    "field" TEXT NOT NULL CHECK ("field" IN ('title', 'originalTitle', 'localizedTitle', 'developer', 'publisher', 'genre', 'description', 'coverUrl')),
    "revision" INTEGER NOT NULL CHECK ("revision" > 0),
    "action" TEXT NOT NULL CHECK ("action" IN ('MANUAL', 'SOURCE', 'UNLOCK')),
    "previousValue" TEXT,
    "value" TEXT NOT NULL,
    "locked" BOOLEAN NOT NULL,
    "sourceJson" TEXT,
    "createdAt" DATETIME NOT NULL,
    FOREIGN KEY ("profileId") REFERENCES "UserGameMetadata"("profileId") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ProfileFieldHistory_profileId_field_revision_key" ON "ProfileFieldHistory"("profileId", "field", "revision");
CREATE INDEX "ProfileFieldHistory_profileId_revision_idx" ON "ProfileFieldHistory"("profileId", "revision");
