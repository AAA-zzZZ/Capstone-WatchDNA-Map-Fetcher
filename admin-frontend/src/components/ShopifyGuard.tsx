import React, { useEffect, useState } from 'react';


const SESSION_KEY = 'shopify_verified';
const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001';

/**
 * Set VITE_REQUIRE_SHOPIFY=false in .env to bypass this guard during local development.
 * In production it defaults to enforced (anything other than the string "false" is treated as enabled).
 */
const REQUIRE_SHOPIFY = import.meta.env.VITE_REQUIRE_SHOPIFY !== 'false';

// TEMPORARY DEBUG LOG — remove once this is sorted out.
console.log('[DEBUG] raw env value:', JSON.stringify(import.meta.env.VITE_REQUIRE_SHOPIFY));
console.log('[DEBUG] REQUIRE_SHOPIFY resolved to:', REQUIRE_SHOPIFY);

type Status = 'checking' | 'allowed' | 'denied';

async function verifyHmac(params: URLSearchParams): Promise<boolean> {
  try {
    const res = await fetch(
      `${API_URL}/api/auth/shopify-verify?${params.toString()}`
    );
    if (!res.ok) return false;
    const data = await res.json();
    return data.valid === true;
  } catch {
    return false;
  }
}

interface ShopifyGuardProps {
  children: React.ReactNode;
}

const ShopifyGuard: React.FC<ShopifyGuardProps> = ({ children }) => {
  const [status, setStatus] = useState<Status>('checking');

  useEffect(() => {
    if (!REQUIRE_SHOPIFY) {
      setStatus('allowed');
      return;
    }

    // Already verified in this browser session
    if (sessionStorage.getItem(SESSION_KEY) === '1') {
      setStatus('allowed');
      return;
    }

    const params = new URLSearchParams(window.location.search);
    const hmac = params.get('hmac');
    const shop = params.get('shop');

    if (!hmac || !shop) {
      setStatus('denied');
      return;
    }

    verifyHmac(params).then((valid) => {
      if (valid) {
        sessionStorage.setItem(SESSION_KEY, '1');
        setStatus('allowed');
      } else {
        setStatus('denied');
      }
    });
  }, []);

  if (status === 'checking') {
    return (
      <div style={styles.center}>
        <p style={styles.message}>Verifying access…</p>
      </div>
    );
  }

  if (status === 'denied') {
    return (
      <div style={styles.center}>
        <h1 style={styles.heading}>Access Restricted</h1>
        <p style={styles.message}>
          This admin console can only be accessed through the Shopify Admin.
        </p>
      </div>
    );
  }

  return <>{children}</>;
};

const styles: Record<string, React.CSSProperties> = {
  center: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100vh',
    fontFamily: 'system-ui, sans-serif',
    backgroundColor: 'var(--gray-900)',
    color: 'var(--gray-50)',
  },
  heading: {
    fontSize: '1.5rem',
    marginBottom: '0.5rem',
  },
  message: {
    fontSize: '1rem',
    color: 'var(--gray-300)',
  },
};

export default ShopifyGuard;