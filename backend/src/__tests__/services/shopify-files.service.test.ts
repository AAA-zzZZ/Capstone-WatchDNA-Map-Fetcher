import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('shopify-files.service', () => {
  const originalEnv = process.env;
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.unstubAllGlobals();
  });

  it('shopifyFilesConfigured is true with domain + static access token', async () => {
    process.env.SHOPIFY_STORE_DOMAIN = 'test.myshopify.com';
    process.env.SHOPIFY_ADMIN_ACCESS_TOKEN = 'shpat_static';
    delete process.env.SHOPIFY_CLIENT_ID;
    delete process.env.SHOPIFY_CLIENT_SECRET;
    const { shopifyFilesConfigured } = await import('../../services/shopify-files.service');
    expect(shopifyFilesConfigured()).toBe(true);
  });

  it('shopifyFilesConfigured is true with domain + client id and secret', async () => {
    process.env.SHOPIFY_STORE_DOMAIN = 'test.myshopify.com';
    delete process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
    process.env.SHOPIFY_CLIENT_ID = 'cid';
    process.env.SHOPIFY_CLIENT_SECRET = 'sec';
    const { shopifyFilesConfigured } = await import('../../services/shopify-files.service');
    expect(shopifyFilesConfigured()).toBe(true);
  });

  it('getShopifyAdminAccessToken uses static token when set', async () => {
    process.env.SHOPIFY_STORE_DOMAIN = 'test.myshopify.com';
    process.env.SHOPIFY_ADMIN_ACCESS_TOKEN = 'shpat_only';
    const { getShopifyAdminAccessToken } = await import('../../services/shopify-files.service');
    await expect(getShopifyAdminAccessToken()).resolves.toBe('shpat_only');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('getShopifyAdminAccessToken exchanges client credentials and caches', async () => {
    process.env.SHOPIFY_STORE_DOMAIN = 'test.myshopify.com';
    delete process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
    process.env.SHOPIFY_CLIENT_ID = 'client-id';
    process.env.SHOPIFY_CLIENT_SECRET = 'client-secret';

    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ access_token: 'tok_one', expires_in: 3600 }),
    });

    const { getShopifyAdminAccessToken } = await import('../../services/shopify-files.service');
    await expect(getShopifyAdminAccessToken()).resolves.toBe('tok_one');
    await expect(getShopifyAdminAccessToken()).resolves.toBe('tok_one');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://test.myshopify.com/admin/oauth/access_token');
    expect(init.method).toBe('POST');
    expect(init.body).toContain('grant_type=client_credentials');
    expect(init.body).toContain('client_id=client-id');
    expect(init.body).toContain('client_secret=client-secret');
  });
});
