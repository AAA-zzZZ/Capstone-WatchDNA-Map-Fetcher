-- CreateTable
CREATE TABLE "Upload" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "filename" TEXT NOT NULL,
    "originalFilename" TEXT NOT NULL,
    "fileSize" INTEGER NOT NULL,
    "uploadedBy" TEXT NOT NULL DEFAULT 'admin',
    "uploadedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "validationErrors" TEXT,
    "validationWarnings" TEXT,
    "rowsTotal" INTEGER NOT NULL DEFAULT 0,
    "rowsProcessed" INTEGER NOT NULL DEFAULT 0,
    "rowsFailed" INTEGER NOT NULL DEFAULT 0,
    "brandConfig" TEXT,
    "scraperType" TEXT
);

-- CreateTable
CREATE TABLE "ValidationLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "uploadId" TEXT NOT NULL,
    "rowNumber" INTEGER,
    "logType" TEXT NOT NULL,
    "fieldName" TEXT,
    "issueType" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "value" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ValidationLog_uploadId_fkey" FOREIGN KEY ("uploadId") REFERENCES "Upload" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Location" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "uploadId" TEXT,
    "handle" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" BOOLEAN NOT NULL DEFAULT true,
    "addressLine1" TEXT NOT NULL,
    "addressLine2" TEXT,
    "postalCode" TEXT,
    "city" TEXT NOT NULL,
    "stateProvinceRegion" TEXT,
    "country" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "website" TEXT,
    "imageUrl" TEXT,
    "monday" TEXT,
    "tuesday" TEXT,
    "wednesday" TEXT,
    "thursday" TEXT,
    "friday" TEXT,
    "saturday" TEXT,
    "sunday" TEXT,
    "latitude" REAL NOT NULL,
    "longitude" REAL NOT NULL,
    "pageTitle" TEXT,
    "pageDescription" TEXT,
    "metaTitle" TEXT,
    "metaDescription" TEXT,
    "priority" INTEGER,
    "tags" TEXT,
    "customBrands" TEXT,
    "nameFr" TEXT,
    "pageTitleFr" TEXT,
    "pageDescriptionFr" TEXT,
    "customBrandsFr" TEXT,
    "nameZhCn" TEXT,
    "pageTitleZhCn" TEXT,
    "pageDescriptionZhCn" TEXT,
    "customBrandsZhCn" TEXT,
    "nameEs" TEXT,
    "pageTitleEs" TEXT,
    "pageDescriptionEs" TEXT,
    "customBrandsEs" TEXT,
    "customButton1Title" TEXT,
    "customButton1Url" TEXT,
    "customButton2Title" TEXT,
    "customButton2Url" TEXT,
    "customButton1TitleFr" TEXT,
    "customButton1UrlFr" TEXT,
    "customButton1TitleZhCn" TEXT,
    "customButton1UrlZhCn" TEXT,
    "customButton1TitleEs" TEXT,
    "customButton1UrlEs" TEXT,
    "customButton2TitleFr" TEXT,
    "customButton2UrlFr" TEXT,
    "customButton2TitleZhCn" TEXT,
    "customButton2UrlZhCn" TEXT,
    "customButton2TitleEs" TEXT,
    "customButton2UrlEs" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Location_uploadId_fkey" FOREIGN KEY ("uploadId") REFERENCES "Upload" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ScraperJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "brandName" TEXT NOT NULL,
    "config" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    "uploadId" TEXT,
    "errorMessage" TEXT,
    "recordsScraped" INTEGER NOT NULL DEFAULT 0,
    "logs" TEXT,
    CONSTRAINT "ScraperJob_uploadId_fkey" FOREIGN KEY ("uploadId") REFERENCES "Upload" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "username" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'admin',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastLogin" DATETIME
);

-- CreateIndex
CREATE INDEX "Upload_status_idx" ON "Upload"("status");

-- CreateIndex
CREATE INDEX "Upload_uploadedAt_idx" ON "Upload"("uploadedAt");

-- CreateIndex
CREATE INDEX "ValidationLog_uploadId_idx" ON "ValidationLog"("uploadId");

-- CreateIndex
CREATE INDEX "ValidationLog_logType_idx" ON "ValidationLog"("logType");

-- CreateIndex
CREATE UNIQUE INDEX "Location_handle_key" ON "Location"("handle");

-- CreateIndex
CREATE INDEX "Location_uploadId_idx" ON "Location"("uploadId");

-- CreateIndex
CREATE INDEX "Location_city_idx" ON "Location"("city");

-- CreateIndex
CREATE INDEX "Location_country_idx" ON "Location"("country");

-- CreateIndex
CREATE INDEX "ScraperJob_status_idx" ON "ScraperJob"("status");

-- CreateIndex
CREATE INDEX "ScraperJob_brandName_idx" ON "ScraperJob"("brandName");

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_username_idx" ON "User"("username");

-- CreateIndex
CREATE INDEX "User_email_idx" ON "User"("email");
