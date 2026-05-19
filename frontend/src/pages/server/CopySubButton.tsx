import { useState } from 'react';
import { clientsApi, subscriptionsApi } from '../../api';
import { copyToClipboard } from './clipboard';

interface Props {
  clientId: string;
}

export default function CopySubButton({ clientId }: Props) {
  const [slug, setSlug] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [loading, setLoading] = useState(false);
  const [url, setUrl] = useState<string | null>(null);

  const fetchAndCopy = async () => {
    setLoading(true);
    try {
      let s = slug;
      if (!s) {
        const r = await clientsApi.subscription(clientId);
        s = r.data.slug;
        setSlug(s);
      }
      if (!s) { alert('Подписка не найдена'); return; }
      const subUrl = subscriptionsApi.subUrl(s);
      setUrl(subUrl);
      await copyToClipboard(subUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } finally {
      setLoading(false);
    }
  };

  return (
    <button
      className={`btn btn-sm ${copied ? 'btn-primary' : 'btn-outline'}`}
      onClick={fetchAndCopy}
      disabled={loading}
      title={url || 'Скопировать URL подписки для FLClash'}
    >
      {loading
        ? <span className="spinner" style={{ width: 12, height: 12 }} />
        : copied ? '✓ Copied' : '📡 Sub URL'}
    </button>
  );
}
