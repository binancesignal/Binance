'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import TripleCrossBacktest from '../../../components/TripleCrossBacktest.js';

export default function TripleCrossPage() {
  const router = useRouter();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    (async () => {
      const res = await fetch('/api/auth/me');
      if (!res.ok) return router.replace('/login');
      const data = await res.json().catch(() => ({}));
      if (data.user?.role !== 'admin') return router.replace('/');
      setReady(true);
    })();
  }, [router]);

  if (!ready) return <div style={{ padding: 16 }}>Loading…</div>;
  return <TripleCrossBacktest />;
}
