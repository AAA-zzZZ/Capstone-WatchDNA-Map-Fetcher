export interface User {
  id: string;
  username: string;
  email: string;
  role: string;
  createdAt: string;
  lastLogin: string | null;
}

export interface LoginCredentials {
  username: string;
  password: string;
}

export interface LoginResponse {
  success: boolean;
  user: User;
  token: string;
}

export interface Upload {
  id: string;
  filename: string;
  originalFilename: string;
  fileSize: number;
  uploadedBy: string;
  uploadedAt: string;
  status: string;
  validationErrors: any[];
  validationWarnings: any[];
  rowsTotal: number;
  rowsProcessed: number;
  rowsFailed: number;
  brandConfig: string | null;
  scraperType: string | null;
  _count?: {
    validationLogs: number;
    locations: number;
  };
}

export interface ValidationLog {
  id: string;
  uploadId: string;
  rowNumber: number | null;
  logType: string;
  fieldName: string | null;
  issueType: string;
  message: string;
  value: string | null;
  createdAt: string;
}

export interface Stats {
  totalUploads: number;
  validUploads: number;
  invalidUploads: number;
  totalLocations: number;
}
