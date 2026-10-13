-- CreateIndex
CREATE UNIQUE INDEX "Edition_releaseId_name_key" ON "Edition"("releaseId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Release_gameId_platformId_region_releaseDate_key" ON "Release"("gameId", "platformId", "region", "releaseDate");
