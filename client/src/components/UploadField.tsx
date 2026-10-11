import { useState } from 'react';
import { api } from '../lib/api';
import { supabase } from '../lib/supabase';
import { optimizeListingImage } from '../lib/images';

export function UploadField({ bucket, onChange, multiple = false, onBusyChange }: {
  bucket: 'listing-images' | 'adoption-documents' | 'rescue-evidence';
  onChange: (paths: string[]) => void;
  multiple?: boolean;
  onBusyChange?: (busy: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [names, setNames] = useState<string[]>([]);
  return <label className="field">{bucket === 'adoption-documents' ? 'Supporting documents' : 'Upload photos'}
    <input type="file" multiple={multiple} disabled={busy} accept={bucket === 'adoption-documents' ? 'image/jpeg,image/png,image/webp,application/pdf' : 'image/jpeg,image/png,image/webp'} onChange={async event => {
      const files = [...(event.target.files || [])];
      setError(''); setBusy(true); onBusyChange?.(true); onChange([]); setNames([]);
      try {
        if (!supabase) throw new Error('Storage is unavailable until Supabase is connected.');
        if (files.length > (multiple ? 6 : 1)) throw new Error('Select no more than six files.');
        const paths: string[] = [];
        for (const original of files) {
          if (original.size > 5 * 1024 * 1024) throw new Error('Each file must be 5 MB or smaller.');
          const file = bucket === 'listing-images' ? await optimizeListingImage(original) : original;
          const upload = await api<{ path: string; token: string }>('/uploads/signed-url', { method: 'POST', body: JSON.stringify({ bucket, filename: file.name, content_type: file.type, size: file.size }) });
          const result = await supabase.storage.from(bucket).uploadToSignedUrl(upload.path, upload.token, file, { contentType: file.type });
          if (result.error) throw result.error;
          paths.push(bucket === 'listing-images' ? supabase.storage.from(bucket).getPublicUrl(upload.path).data.publicUrl : upload.path);
        }
        onChange(paths); setNames(files.map(file => file.name));
      } catch (failure) { setError((failure as Error).message); }
      finally { setBusy(false); onBusyChange?.(false); }
    }} />
    {busy && <span role="status">Uploading… Wait for the upload to finish before saving.</span>}
    {names.length > 0 && <span>Uploaded: {names.join(', ')}</span>}
    {error && <span className="error" role="alert">{error}</span>}
  </label>;
}
export function PrivateFile({ bucket, path }: { bucket: 'adoption-documents' | 'rescue-evidence'; path: string }) {
  const [error, setError] = useState('');
  return <span><button type="button" className="text-button" onClick={async () => {
    setError('');
    try { const result = await api<{ signed_url: string }>('/uploads/read-url', { method: 'POST', body: JSON.stringify({ bucket, path }) }); window.open(result.signed_url, '_blank', 'noopener,noreferrer'); }
    catch (failure) { setError((failure as Error).message); }
  }}>Open attached file</button>{error && <span role="alert">{error}</span>}</span>;
}
