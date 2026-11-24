-- CreateTable
CREATE TABLE "SteamAccount" (
    "userId" TEXT NOT NULL PRIMARY KEY,
    "steamId" TEXT NOT NULL,
    "verifiedAt" DATETIME NOT NULL,
    CONSTRAINT "SteamAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SteamAuthAttempt" (
    "stateHash" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "sessionHash" TEXT NOT NULL,
    "returnTo" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    CONSTRAINT "SteamAuthAttempt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SteamImportPreview" (
    "tokenHash" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "steamId" TEXT NOT NULL,
    "payloadJson" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    CONSTRAINT "SteamImportPreview_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SteamImportLink" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "steamId" TEXT NOT NULL,
    "appid" BIGINT NOT NULL,
    "gameId" TEXT NOT NULL,
    "libraryItemId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SteamImportLink_userId_gameId_fkey" FOREIGN KEY ("userId", "gameId") REFERENCES "UserGameProfile" ("userId", "gameId") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SteamImportLink_libraryItemId_fkey" FOREIGN KEY ("libraryItemId") REFERENCES "LibraryItem" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "SteamAuthAttempt_userId_idx" ON "SteamAuthAttempt"("userId");

-- CreateIndex
CREATE INDEX "SteamAuthAttempt_expiresAt_idx" ON "SteamAuthAttempt"("expiresAt");

-- CreateIndex
CREATE INDEX "SteamImportPreview_userId_idx" ON "SteamImportPreview"("userId");

-- CreateIndex
CREATE INDEX "SteamImportPreview_expiresAt_idx" ON "SteamImportPreview"("expiresAt");

-- CreateIndex
CREATE INDEX "SteamImportLink_libraryItemId_idx" ON "SteamImportLink"("libraryItemId");

-- CreateIndex
CREATE UNIQUE INDEX "SteamImportLink_userId_steamId_appid_key" ON "SteamImportLink"("userId", "steamId", "appid");
