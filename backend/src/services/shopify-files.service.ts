/**
 * Upload images to Shopify Admin **Content → Files** via stagedUploadsCreate + fileCreate.
 *
 * Auth: SHOPIFY_STORE_DOMAIN + (SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET) with client_credentials
 * token refresh, or SHOPIFY_ADMIN_ACCESS_TOKEN as a static override. Requires write_files (or write_images).
 */

import { config } from '../config';
import { logger } from '../utils/logger';

/** Refresh this many ms before Shopify's expires_in to avoid edge failures. */
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

let cachedAccessToken: string | null = null;
/** Epoch ms: refresh when Date.now() >= this (already accounts for buffer). */
let accessTokenRefreshAfterMs = 0;
let tokenRefreshInFlight: Promise<string> | null = null;

const STAGED_UPLOAD_MUTATION = `
mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
  stagedUploadsCreate(input: $input) {
    stagedTargets {
      url
      resourceUrl
      parameters {
        name
        value
      }
    }
    userErrors {
      field
      message
    }
  }
}
`;

const FILE_CREATE_MUTATION = `
mutation fileCreate($files: [FileCreateInput!]!) {
  fileCreate(files: $files) {
    files {
      id
      fileStatus
      ... on MediaImage {
        image {
          url
        }
      }
    }
    userErrors {
      field
      message
    }
  }
}
`;

const FILE_DELETE_MUTATION = `
mutation fileDelete($fileIds: [ID!]!) {
  fileDelete(fileIds: $fileIds) {
    deletedFileIds
    userErrors {
      field
      message
    }
  }
}
`;

const FILE_NODE_QUERY = `
query fileNode($id: ID!) {
  node(id: $id) {
    ... on MediaImage {
      fileStatus
      image {
        url
      }
    }
  }
}
`;

const FILES_SEARCH_QUERY = `
query filesSearch($query: String!, $first: Int!) {
  files(first: $first, query: $query, sortKey: CREATED_AT, reverse: true) {
    edges {
      node {
        id
        fileStatus
        alt
        createdAt
        ... on MediaImage {
          image {
            url
            width
            height
          }
        }
      }
    }
  }
}
`;

export interface ShopifyFileResult {
  id: string;
  alt: string | null;
  url: string | null;
  width: number | null;
  height: number | null;
  createdAt: string;
  fileStatus: string;
}

/**
 * Search Shopify Content → Files by filename/query. Requires read_files scope.
 */
export async function searchShopifyFiles(query: string, limit = 20): Promise<ShopifyFileResult[]> {
  if (!shopifyFilesConfigured()) return [];

  const q = query.trim() || 'media_type:Image';
  const data = await adminGraphql<{
    files: {
      edges: Array<{
        node: {
          id: string;
          fileStatus: string;
          alt?: string | null;
          createdAt: string;
          image?: { url?: string | null; width?: number | null; height?: number | null } | null;
        };
      }>;
    };
  }>(FILES_SEARCH_QUERY, { query: q, first: Math.min(limit, 50) });

  return data.files.edges.map(({ node }) => ({
    id: node.id,
    alt: node.alt ?? null,
    url: node.image?.url ?? null,
    width: node.image?.width ?? null,
    height: node.image?.height ?? null,
    createdAt: node.createdAt,
    fileStatus: node.fileStatus,
  }));
}

function normalizeShopDomain(raw: string): string {
  const t = raw.trim().toLowerCase().replace(/^https?:\/\//, '').split('/')[0] ?? '';
  if (!t) return '';
  return t.endsWith('.myshopify.com') ? t : `${t}.myshopify.com`;
}

export function shopifyFilesConfigured(): boolean {
  const { storeDomain, accessToken, clientId, clientSecret } = config.shopify;
  const domain = normalizeShopDomain(storeDomain);
  if (!domain) return false;
  if (accessToken?.trim()) return true;
  return Boolean(clientId?.trim() && clientSecret?.trim());
}

async function exchangeClientCredentialsToken(): Promise<{ accessToken: string; expiresInSec: number }> {
  const shop = normalizeShopDomain(config.shopify.storeDomain);
  const clientId = config.shopify.clientId.trim();
  const clientSecret = config.shopify.clientSecret.trim();
  if (!shop || !clientId || !clientSecret) {
    throw new Error('Shopify client credentials are not configured');
  }

  const url = `https://${shop}/admin/oauth/access_token`;
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
  });

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  const json = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };

  if (!res.ok || !json.access_token) {
    const msg = json.error_description || json.error || `HTTP ${res.status}`;
    logger.error(`[shopify-auth] token exchange failed shop=${shop} http=${res.status}`, msg);
    throw new Error(`Shopify OAuth token exchange failed: ${msg}`);
  }

  const expiresInSec = typeof json.expires_in === 'number' && json.expires_in > 0 ? json.expires_in : 86399;
  return { accessToken: json.access_token, expiresInSec };
}

/**
 * Admin API access token: static env override, or client_credentials with in-memory cache.
 */
export async function getShopifyAdminAccessToken(): Promise<string> {
  const staticTok = config.shopify.accessToken.trim();
  if (staticTok) {
    logger.debug('[shopify-auth] using SHOPIFY_ADMIN_ACCESS_TOKEN override (not client_credentials)');
    return staticTok;
  }

  const now = Date.now();
  if (cachedAccessToken && now < accessTokenRefreshAfterMs) {
    return cachedAccessToken;
  }

  if (tokenRefreshInFlight) {
    return tokenRefreshInFlight;
  }

  tokenRefreshInFlight = (async () => {
    const shop = normalizeShopDomain(config.shopify.storeDomain);
    logger.integration(
      `[shopify-auth] requesting new Admin API token (client_credentials) shop=${shop}`
    );
    const { accessToken, expiresInSec } = await exchangeClientCredentialsToken();
    cachedAccessToken = accessToken;
    accessTokenRefreshAfterMs = Date.now() + expiresInSec * 1000 - TOKEN_REFRESH_BUFFER_MS;
    logger.integration(
      `[shopify-auth] token cached shop=${shop} expiresInSec=${expiresInSec} refreshBufferMs=${TOKEN_REFRESH_BUFFER_MS}`
    );
    return accessToken;
  })();

  try {
    return await tokenRefreshInFlight;
  } finally {
    tokenRefreshInFlight = null;
  }
}

function adminGraphqlUrl(): string {
  const host = normalizeShopDomain(config.shopify.storeDomain);
  const ver = config.shopify.adminApiVersion.trim() || '2025-10';
  return `https://${host}/admin/api/${ver}/graphql.json`;
}

type GraphqlResponse<T> = { data?: T; errors?: { message: string }[] };

async function adminGraphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const token = await getShopifyAdminAccessToken();
  const res = await fetch(adminGraphqlUrl(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': token,
    },
    body: JSON.stringify({ query, variables }),
  });

  const json = (await res.json()) as GraphqlResponse<T> & { errors?: { message: string }[] };
  if (!res.ok) {
    logger.error(`[shopify-api] GraphQL HTTP ${res.status} url=${adminGraphqlUrl()}`);
    throw new Error(`Shopify GraphQL HTTP ${res.status}`);
  }
  if (json.errors?.length) {
    const msg = json.errors.map((e) => e.message).join('; ');
    logger.error('[shopify-api] GraphQL errors', msg);
    throw new Error(msg);
  }
  if (!json.data) {
    logger.error('[shopify-api] GraphQL returned no data');
    throw new Error('Shopify GraphQL returned no data');
  }
  return json.data;
}

async function pollMediaImageUrl(fileId: string, storeHandle: string): Promise<string> {
  const maxAttempts = 30;
  const delayMs = 500;

  for (let i = 0; i < maxAttempts; i++) {
    const data = await adminGraphql<{
      node: { fileStatus?: string; image?: { url?: string | null } | null } | null;
    }>(FILE_NODE_QUERY, { id: fileId });

    const node = data.node;
    const status = node?.fileStatus;
    const url = node?.image?.url;

    // Only return the URL once Shopify marks the file READY — this ensures the CDN
    // has fully replicated the image before we store the URL in the database.
    if (status === 'READY' && url) {
      logger.integration(
        `[shopify-upload] CDN URL ready after poll handle=${storeHandle} fileId=${fileId} attempts=${i + 1}`
      );
      return url;
    }

    if (status === 'FAILED') {
      throw new Error('Shopify file processing failed');
    }

    if (i === 0) {
      logger.integration(
        `[shopify-upload] waiting for Shopify to process image handle=${storeHandle} fileId=${fileId} fileStatus=${status ?? 'unknown'}`
      );
    }

    await new Promise((r) => setTimeout(r, delayMs));
  }

  throw new Error('Timed out waiting for Shopify image URL');
}

/**
 * Upload raw image bytes to Shopify Files.
 * Returns the CDN URL and the Shopify file GID to store in Location.
 */
export async function uploadPremiumStoreImageToShopify(options: {
  buffer: Buffer;
  mimeType: string;
  filename: string;
  alt: string;
  /** For logs / monitoring (store locator handle). */
  storeHandle: string;
}): Promise<{ cdnUrl: string; fileGid: string }> {
  if (!shopifyFilesConfigured()) {
    throw new Error('Shopify file uploads are not configured');
  }

  const { buffer, mimeType, filename, alt, storeHandle } = options;
  const shop = normalizeShopDomain(config.shopify.storeDomain);
  const t0 = Date.now();

  logger.integration(
    `[shopify-upload] start handle=${storeHandle} shop=${shop} bytes=${buffer.length} mime=${mimeType} filename=${filename}`
  );

  const stagedData = await adminGraphql<{
    stagedUploadsCreate: {
      stagedTargets: Array<{
        url: string;
        resourceUrl: string;
        parameters: Array<{ name: string; value: string }>;
      }>;
      userErrors: Array<{ message: string }>;
    };
  }>(STAGED_UPLOAD_MUTATION, {
    input: [
      {
        filename,
        mimeType,
        resource: 'IMAGE',
        httpMethod: 'POST',
      },
    ],
  });

  const staged = stagedData.stagedUploadsCreate;
  if (staged.userErrors?.length) {
    const msg = staged.userErrors.map((e) => e.message).join('; ');
    logger.error(`[shopify-upload] stagedUploadsCreate userErrors handle=${storeHandle}`, msg);
    throw new Error(msg);
  }

  const target = staged.stagedTargets[0];
  if (!target?.url || !target.resourceUrl) {
    logger.error(`[shopify-upload] no staged target handle=${storeHandle}`);
    throw new Error('Shopify stagedUploadsCreate returned no target');
  }

  let uploadHost = target.url;
  try {
    uploadHost = new URL(target.url).host;
  } catch {
    /* relative or opaque URL — log as-is (truncated) */
    uploadHost = target.url.length > 120 ? `${target.url.slice(0, 120)}…` : target.url;
  }
  logger.integration(`[shopify-upload] staged target ready handle=${storeHandle} uploadTarget=${uploadHost}`);

  const form = new FormData();
  for (const { name, value } of target.parameters) {
    form.append(name, value);
  }
  form.append('file', new Blob([new Uint8Array(buffer)], { type: mimeType }), filename);

  const uploadRes = await fetch(target.url, {
    method: 'POST',
    body: form,
  });

  if (!uploadRes.ok) {
    const hint = await uploadRes.text().catch(() => '');
    logger.error(
      `[shopify-upload] binary POST to staged URL failed handle=${storeHandle} http=${uploadRes.status}`,
      hint.slice(0, 300)
    );
    throw new Error(`Shopify staged upload failed: HTTP ${uploadRes.status} ${hint.slice(0, 200)}`);
  }

  logger.integration(`[shopify-upload] staged bytes uploaded handle=${storeHandle} http=${uploadRes.status}`);

  const createData = await adminGraphql<{
    fileCreate: {
      files: Array<{
        id?: string;
        fileStatus?: string;
        image?: { url?: string | null } | null;
      } | null>;
      userErrors: Array<{ message: string }>;
    };
  }>(FILE_CREATE_MUTATION, {
    files: [
      {
        alt,
        contentType: 'IMAGE',
        originalSource: target.resourceUrl,
        filename,
      },
    ],
  });

  const fc = createData.fileCreate;
  if (fc.userErrors?.length) {
    const msg = fc.userErrors.map((e) => e.message).join('; ');
    logger.error(`[shopify-upload] fileCreate userErrors handle=${storeHandle}`, msg);
    throw new Error(msg);
  }

  const created = fc.files[0];
  const id = created?.id;
  if (!id) {
    logger.error(`[shopify-upload] fileCreate missing file id handle=${storeHandle}`);
    throw new Error('Shopify fileCreate returned no file id');
  }

  const immediate = created.image?.url;
  const status = created.fileStatus;
  logger.integration(
    `[shopify-upload] fileCreate ok handle=${storeHandle} mediaId=${id} fileStatus=${status ?? 'unknown'} immediateUrl=${immediate ? 'yes' : 'no'}`
  );

  // Only skip polling when Shopify already reports the file as READY — this guarantees
  // the CDN has fully replicated the image before we persist the URL.
  if (status === 'READY' && immediate) {
    logger.integration(
      `[shopify-upload] complete handle=${storeHandle} ms=${Date.now() - t0} url=${immediate}`
    );
    return { cdnUrl: immediate, fileGid: id };
  }

  const polled = await pollMediaImageUrl(id, storeHandle);
  logger.integration(
    `[shopify-upload] complete handle=${storeHandle} ms=${Date.now() - t0} url=${polled}`
  );
  return { cdnUrl: polled, fileGid: id };
}

/**
 * Delete a file from Shopify Content → Files by its GID. Fire-and-forget safe; logs errors.
 */
export async function deleteShopifyFile(fileGid: string): Promise<void> {
  if (!shopifyFilesConfigured()) return;
  try {
    const data = await adminGraphql<{
      fileDelete: {
        deletedFileIds: string[];
        userErrors: Array<{ message: string }>;
      };
    }>(FILE_DELETE_MUTATION, { fileIds: [fileGid] });

    const fd = data.fileDelete;
    if (fd.userErrors?.length) {
      const msg = fd.userErrors.map((e) => e.message).join('; ');
      logger.warn(`[shopify-files] fileDelete userErrors gid=${fileGid}`, msg);
      return;
    }
    logger.integration(`[shopify-files] deleted file gid=${fileGid}`);
  } catch (err) {
    logger.warn(`[shopify-files] fileDelete failed gid=${fileGid}`, err);
  }
}
