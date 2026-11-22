import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  buildAndInspectDaos,
  CHAINS,
  decryptBytesAesGcm,
  loadBayConfig,
  saveBayConfig,
  scanArkivReleases,
  unlockGateStandalone,
  type BayConfig,
  type BayRelease,
  type DaoTrackerEntry,
  type Eip1193Provider,
  type ReleaseCategory,
} from './lib/protocol';
import {
  pinToFilecoinSynapse,
  publishToArkiv,
  sealUploadFile,
  type HavenUploadGroup,
  type SealedRelease,
} from './lib/uploader';
import { registerHavenOsBridge, type HavenOsBridgeClient } from './lib/osBridge';

type Tab = 'browse' | 'upload' | 'daos' | 'settings';

function fmtSize(bytes?: number): string {
  if (!bytes) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

function shortAddr(addr: string): string {
  if (!addr || addr.length < 10) return addr || 'Anon';
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function ShipLogo() {
  return (
    <svg width="46" height="46" viewBox="0 0 64 64" className="bay-logo" aria-hidden>
      <circle cx="32" cy="32" r="30" fill="#f3e9dc" stroke="#8b5a2b" strokeWidth="2" />
      <path d="M12 42 Q32 52 52 42 L47 50 Q32 56 17 50 Z" fill="#5c3a1e" />
      <rect x="30" y="13" width="3" height="29" fill="#5c3a1e" />
      <path d="M33 15 Q48 22 44 37 L33 35 Z" fill="#8b5a2b" />
      <path d="M29 18 Q18 24 21 36 L29 35 Z" fill="#a87644" />
      <text x="38" y="30" fontSize="9" fontWeight="bold" fill="#fff" textAnchor="middle">
        H
      </text>
    </svg>
  );
}

export function App() {
  const [config, setConfig] = useState<BayConfig>(() => loadBayConfig());
  const [tab, setTab] = useState<Tab>('browse');
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<'all' | ReleaseCategory>('all');
  const [gatedOnly, setGatedOnly] = useState(false);

  const [walletAddr, setWalletAddr] = useState<string | null>(null);
  const [osBridgeActive, setOsBridgeActive] = useState(false);
  const bridgeRef = useRef<HavenOsBridgeClient | null>(null);
  const providerRef = useRef<Eip1193Provider | null>(null);

  const [releases, setReleases] = useState<BayRelease[]>([]);
  const [daos, setDaos] = useState<DaoTrackerEntry[]>([]);
  const [scanning, setScanning] = useState(false);
  const [blockNumber, setBlockNumber] = useState<number | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [keyring, setKeyring] = useState<Record<string, Uint8Array>>({});
  const [toast, setToast] = useState<string | null>(null);

  // Upload state
  const [file, setFile] = useState<File | null>(null);
  const [grp, setGrp] = useState<HavenUploadGroup>('haven.audio.full');
  const [title, setTitle] = useState('');
  const [artist, setArtist] = useState('');
  const [album, setAlbum] = useState('');
  const [description, setDescription] = useState('');
  const [tagsText, setTagsText] = useState('haven, filecoin');
  const [gated, setGated] = useState(false);
  const [chainId, setChainId] = useState(8453);
  const [tokenAddress, setTokenAddress] = useState('');
  const [threshold, setThreshold] = useState('1');
  const [sealed, setSealed] = useState<SealedRelease | null>(null);
  const [cid, setCid] = useState('');
  const [busyStep, setBusyStep] = useState<string | null>(null);
  const [publishedKey, setPublishedKey] = useState<string | null>(null);

  const notify = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast((c) => (c === msg ? null : c)), 3600);
  }, []);

  const updateConfig = useCallback((patch: Partial<BayConfig>) => {
    setConfig((prev) => {
      const next = { ...prev, ...patch };
      saveBayConfig(next);
      return next;
    });
  }, []);

  const refresh = useCallback(async () => {
    setScanning(true);
    setScanError(null);
    const res = await scanArkivReleases(config);
    setScanning(false);
    setBlockNumber(res.blockNumber);
    if (res.error) setScanError(res.error);
    setReleases(res.releases);
    const inspected = await buildAndInspectDaos(res.releases, walletAddr);
    setDaos(inspected);
  }, [config, walletAddr]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Haven OS cross-site bridge (haven-os:v1)
  useEffect(() => {
    const bridge = registerHavenOsBridge({ appId: 'haven-bay' });
    if (!bridge) return;
    bridgeRef.current = bridge;

    void bridge.waitForWelcome(2000).then((w) => {
      if (!w) return;
      setOsBridgeActive(true);
      providerRef.current = bridge.provider as unknown as Eip1193Provider;
      if (w.config) {
        updateConfig({
          arkivPreset: w.config.arkivRpcUrl.includes('127.0.0.1')
            ? 'localhost'
            : w.config.arkivRpcUrl.includes('rabdi')
              ? 'rabdi'
              : 'custom',
          arkivRpcUrl: w.config.arkivRpcUrl,
          ipfsGateway: w.config.ipfsGateway,
          aolCanisterId: w.config.havenAolCanisterId,
          icpHost: w.config.icpHost,
        });
      }
      if (w.wallet?.address) {
        setWalletAddr(w.wallet.address.toLowerCase());
      }
    });

    const offAcc = bridge.onEvent('accountsChanged', (data) => {
      const accs = Array.isArray(data) ? (data as string[]) : [];
      setWalletAddr(accs[0] ? accs[0].toLowerCase() : null);
    });
    return () => offAcc();
  }, [updateConfig]);

  const connectWallet = async () => {
    try {
      if (bridgeRef.current?.connectedToHost) {
        const accs = (await bridgeRef.current.provider.request({ method: 'eth_requestAccounts' })) as string[];
        if (accs[0]) {
          providerRef.current = bridgeRef.current.provider as unknown as Eip1193Provider;
          setWalletAddr(accs[0].toLowerCase());
          notify(`Attached via Haven OS Shared Wallet (${shortAddr(accs[0])})`);
        }
        return;
      }
      const eth = (window as unknown as { ethereum?: Eip1193Provider }).ethereum;
      if (!eth) throw new Error('No EVM wallet detected.');
      const accs = (await eth.request({ method: 'eth_requestAccounts' })) as string[];
      if (accs[0]) {
        providerRef.current = eth;
        setWalletAddr(accs[0].toLowerCase());
        notify(`Connected ${shortAddr(accs[0])}`);
      }
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Wallet connection failed');
    }
  };

  const unlockGate = async (gate: NonNullable<BayRelease['gate']>, epoch?: number): Promise<Uint8Array | null> => {
    if (keyring[gate.gateId]) return keyring[gate.gateId];
    if (!walletAddr || !providerRef.current) {
      notify('Connect your wallet first to unlock VetKD gates.');
      return null;
    }
    try {
      let rawKey: Uint8Array;
      if (bridgeRef.current?.connectedToHost) {
        const cached = await bridgeRef.current.getGateKey(gate.gateId, epoch);
        const resolved =
          cached ??
          (await bridgeRef.current.unlockGate({
            gateId: gate.gateId,
            chainId: gate.chainId,
            tokenAddress: gate.tokenAddress,
            threshold: gate.threshold,
            epoch,
          }));
        const bin = atob(resolved.rawKeyBase64);
        rawKey = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) rawKey[i] = bin.charCodeAt(i);
      } else {
        const res = await unlockGateStandalone({
          config,
          provider: providerRef.current,
          address: walletAddr,
          chainId: gate.chainId,
          tokenAddress: gate.tokenAddress,
          threshold: gate.threshold,
          epoch,
        });
        rawKey = res.rawKey;
      }
      setKeyring((prev) => ({ ...prev, [gate.gateId]: rawKey }));
      notify(`Unlocked DataDAO gate ${gate.gateId} via Haven-AOL VetKD!`);
      return rawKey;
    } catch (err) {
      notify(err instanceof Error ? err.message : 'VetKD unlock failed');
      return null;
    }
  };

  const handleDownload = async (r: BayRelease) => {
    if (!r.downloadUrl) {
      notify('No Filecoin/IPFS CID attached to this release.');
      return;
    }
    try {
      let key: Uint8Array | null = null;
      if (r.encrypted && r.gate) {
        key = await unlockGate(r.gate, r.epoch);
        if (!key) return;
      }
      notify(`Fetching ${r.cid?.slice(0, 14) || r.title} from gateway…`);
      const resp = await fetch(r.downloadUrl);
      if (!resp.ok) throw new Error(`Gateway returned HTTP ${resp.status}`);
      let bytes: Uint8Array = new Uint8Array(await resp.arrayBuffer());
      if (r.encrypted && key) {
        bytes = await decryptBytesAesGcm(bytes, key);
      }
      const buf = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(buf).set(bytes);
      const blob = new Blob([buf], { type: r.mimeType || 'application/octet-stream' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = r.title.replace(/[^\w.-]+/g, '_');
      a.click();
      notify(`Downloaded ${r.title}${r.encrypted ? ' (decrypted)' : ''}.`);
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Download failed');
    }
  };

  const handleSeal = async () => {
    if (!file) return;
    setBusyStep('Step 1: Computing SHA-256 & sealing…');
    try {
      const s = await sealUploadFile(
        {
          file,
          grp,
          title: title || file.name,
          artist,
          album,
          description,
          tags: tagsText.split(',').map((t) => t.trim()).filter(Boolean),
          gated,
          chainId,
          tokenAddress,
          threshold,
        },
        walletAddr,
        config,
      );
      setSealed(s);
      setPublishedKey(null);
      notify(`Sealed ${file.name} (${s.ciphertextBytes.byteLength.toLocaleString()} bytes).`);
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Sealing failed');
    } finally {
      setBusyStep(null);
    }
  };

  const handlePinSynapse = async () => {
    if (!sealed) return;
    if (!walletAddr || !providerRef.current) {
      notify('Connect wallet first to pin to Filecoin Synapse.');
      return;
    }
    setBusyStep('Step 2: Pinning to Filecoin Onchain Cloud (Synapse)…');
    try {
      const res = await pinToFilecoinSynapse({
        provider: providerRef.current,
        address: walletAddr,
        bytes: sealed.ciphertextBytes,
        onStatus: (m) => setBusyStep(m),
      });
      setCid(res.pieceCid);
      notify(`Pinned to Filecoin: ${res.pieceCid.slice(0, 16)}…`);
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Synapse upload failed');
    } finally {
      setBusyStep(null);
    }
  };

  const handlePublishArkiv = async () => {
    if (!sealed || !cid.trim()) return;
    if (!walletAddr || !providerRef.current) {
      notify('Connect wallet first to publish to Arkiv OP L3.');
      return;
    }
    setBusyStep('Step 3: Publishing entity to Arkiv OP L3…');
    try {
      const res = await publishToArkiv({
        provider: providerRef.current,
        address: walletAddr,
        config,
        sealed,
        cid: cid.trim(),
        onStatus: (m) => setBusyStep(m),
      });
      setPublishedKey(res.entityKey);
      notify(`Published to Arkiv L3! Entity ${res.entityKey.slice(0, 12)}…`);
      await refresh();
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Arkiv publish failed');
    } finally {
      setBusyStep(null);
    }
  };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return releases.filter((r) => {
      if (category !== 'all' && r.category !== category) return false;
      if (gatedOnly && !r.gate) return false;
      if (!q) return true;
      return (
        r.title.toLowerCase().includes(q) ||
        r.grp.toLowerCase().includes(q) ||
        r.uploader.toLowerCase().includes(q) ||
        (r.cid && r.cid.toLowerCase().includes(q)) ||
        r.tags.some((t) => t.toLowerCase().includes(q))
      );
    });
  }, [category, gatedOnly, releases, search]);

  return (
    <div className="bay-app">
      <header className="bay-header">
        <div className="bay-brand" onClick={() => setTab('browse')}>
          <ShipLogo />
          <div>
            <h1>The Haven Bay</h1>
            <div className="bay-tagline">The galaxy&apos;s most resilient Arkiv L3 &amp; Filecoin DataDAO tracker</div>
          </div>
        </div>

        <nav className="bay-nav">
          <button className={tab === 'browse' ? 'active' : ''} onClick={() => setTab('browse')}>
            Browse Releases ({releases.length})
          </button>
          <button className={tab === 'upload' ? 'active' : ''} onClick={() => setTab('upload')}>
            ▲ Upload / Seed
          </button>
          <button className={tab === 'daos' ? 'active' : ''} onClick={() => setTab('daos')}>
            DataDAO Trackers ({daos.length})
          </button>
          <button className={tab === 'settings' ? 'active' : ''} onClick={() => setTab('settings')}>
            Settings
          </button>
        </nav>

        <div className="bay-status">
          {osBridgeActive && <span className="bay-pill ok">● OS BRIDGE</span>}
          <span className="bay-pill" title={config.arkivRpcUrl}>
            {config.arkivPreset.toUpperCase()}
            {blockNumber ? ` #${blockNumber}` : ''}
          </span>
          <button className="bay-btn" onClick={() => void connectWallet()}>
            {walletAddr ? shortAddr(walletAddr) : 'Connect Wallet'}
          </button>
        </div>
      </header>

      <main className="bay-main">
        {tab === 'browse' && (
          <>
            <div className="bay-searchbar">
              <input
                type="search"
                className="bay-search-input"
                placeholder="Search Haven releases, CIDs, creators, or DataDAO tokens…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <button className="bay-btn" onClick={() => void refresh()}>
                {scanning ? 'Scanning…' : '↻ Sync Arkiv'}
              </button>
              <button className="bay-btn bay-btn-primary" onClick={() => setTab('upload')}>
                ▲ Upload New Release
              </button>
            </div>

            <div className="bay-filters">
              {(['all', 'audio', 'video', 'game', 'file'] as const).map((c) => (
                <label key={c} className="bay-check">
                  <input type="radio" name="cat" checked={category === c} onChange={() => setCategory(c)} />
                  {c === 'all' ? 'All' : c === 'game' ? 'Games / DDR Packs' : c.charAt(0).toUpperCase() + c.slice(1)}
                </label>
              ))}
              <label className="bay-check" style={{ marginLeft: 12 }}>
                <input type="checkbox" checked={gatedOnly} onChange={(e) => setGatedOnly(e.target.checked)} />
                Token-Gated DataDAOs Only
              </label>
            </div>

            {scanError && <div className="bay-alert">Arkiv RPC notice: {scanError}</div>}

            <table className="bay-table">
              <thead>
                <tr>
                  <th style={{ width: 92 }}>Type</th>
                  <th>Name / Magnet / CID</th>
                  <th style={{ width: 78 }}>Size</th>
                  <th style={{ width: 130 }}>Gate / Standing</th>
                  <th style={{ width: 112 }}>Uploader</th>
                  <th style={{ width: 138 }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="bay-empty">
                      {scanning ? 'Querying Arkiv OP L3…' : 'No releases match your filter. Click "Upload / Seed" to publish one!'}
                    </td>
                  </tr>
                ) : (
                  filtered.map((r) => {
                    const unlocked = r.gate ? Boolean(keyring[r.gate.gateId]) : true;
                    return (
                      <tr key={r.entityKey}>
                        <td className="bay-cat">
                          <strong>{r.category.toUpperCase()}</strong>
                          <div className="bay-grp">{r.grp.replace('haven.', '')}</div>
                        </td>
                        <td>
                          <div className="bay-title-row">
                            <span className="bay-title">{r.title}</span>
                            {r.attested && (
                              <span className="bay-skull" title="Verified token-holder attestation (payload.attn)">
                                ☠ VIP Holder
                              </span>
                            )}
                          </div>
                          <div className="bay-meta">
                            {r.cid ? (
                              <code className="bay-mono">haven://{r.cid.slice(0, 28)}…</code>
                            ) : (
                              <code className="bay-mono">arkiv:{r.entityKey.slice(0, 18)}…</code>
                            )}
                            {r.description && <span> · {r.description.slice(0, 72)}</span>}
                          </div>
                        </td>
                        <td className="bay-num">{fmtSize(r.sizeBytes)}</td>
                        <td>
                          {!r.gate ? (
                            <span className="bay-tag pub">Public Commons</span>
                          ) : unlocked ? (
                            <span className="bay-tag ok">🔓 Unlocked</span>
                          ) : (
                            <button
                              className="bay-btn bay-btn-xs"
                              onClick={() => r.gate && void unlockGate(r.gate, r.epoch)}
                            >
                              🔒 Unlock VetKD
                            </button>
                          )}
                        </td>
                        <td className="bay-mono">{shortAddr(r.uploader)}</td>
                        <td className="bay-actions">
                          <button className="bay-btn bay-btn-xs" onClick={() => void handleDownload(r)}>
                            ⬇ {r.encrypted ? 'Decrypt' : 'Get'}
                          </button>
                          <button
                            className="bay-btn bay-btn-xs"
                            onClick={() => {
                              const uri = `haven://${r.cid || r.entityKey}`;
                              void navigator.clipboard?.writeText(uri);
                              notify(`Copied ${uri}`);
                            }}
                          >
                            🧲 URI
                          </button>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </>
        )}

        {tab === 'upload' && (
          <div className="bay-panel">
            <h2>Universal Haven Uploader &amp; Filecoin Seeder</h2>
            <p className="bay-sub">
              Publish any file to the Haven L7 stack. Audio &amp; video releases immediately appear in{' '}
              <strong>Haven Tunes 2000</strong>; dance packs appear in <strong>FeetOnFire</strong>; general files appear
              in <strong>Haven Explorer</strong>.
            </p>

            <div className="bay-form">
              <label>Target Category (`grp`)</label>
              <select
                value={grp}
                onChange={(e) => setGrp(e.target.value as HavenUploadGroup)}
              >
                <option value="haven.audio.full">Audio (`haven.audio.full` → Haven Tunes 2000)</option>
                <option value="haven.video.full">Video (`haven.video.full` → Haven Tunes 2000)</option>
                <option value="haven.game.dance.pack">Dance Pack (`haven.game.dance.pack` → FeetOnFire)</option>
                <option value="haven.file.full">Archive / Document (`haven.file.full` → Haven Explorer)</option>
              </select>

              <label>File to Seed</label>
              <input
                type="file"
                onChange={(e) => {
                  const f = e.target.files?.[0] ?? null;
                  setFile(f);
                  if (f) {
                    if (!title) setTitle(f.name.replace(/\.[^.]+$/, ''));
                    if (f.type.startsWith('audio/')) setGrp('haven.audio.full');
                    else if (f.type.startsWith('video/')) setGrp('haven.video.full');
                    else if (f.name.endsWith('.zip') || f.name.endsWith('.sm') || f.name.endsWith('.ssc'))
                      setGrp('haven.game.dance.pack');
                    else setGrp('haven.file.full');
                  }
                  setSealed(null);
                  setPublishedKey(null);
                }}
              />

              <label>Release Title</label>
              <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Name of release" />

              <label>Creator / Artist</label>
              <input value={artist} onChange={(e) => setArtist(e.target.value)} placeholder="Creator handle or 0x…" />

              <label>Collection / Album</label>
              <input value={album} onChange={(e) => setAlbum(e.target.value)} placeholder="Album, series, or DataDAO" />

              <label>Tags</label>
              <input value={tagsText} onChange={(e) => setTagsText(e.target.value)} />

              <label>Description / NFO</label>
              <textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />

              <label>Access Gate</label>
              <label className="bay-check">
                <input type="checkbox" checked={gated} onChange={(e) => setGated(e.target.checked)} />
                Encrypt (AES-256-GCM) &amp; Token-Gate via Haven-AOL VetKD IBE
              </label>

              {gated && (
                <>
                  <label>EVM Gate Chain</label>
                  <select value={chainId} onChange={(e) => setChainId(Number(e.target.value))}>
                    {Object.values(CHAINS).map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name} (eip155:{c.id})
                      </option>
                    ))}
                  </select>

                  <label>Token Contract</label>
                  <input
                    className="bay-mono"
                    value={tokenAddress}
                    onChange={(e) => setTokenAddress(e.target.value)}
                    placeholder="0x… ERC-20 or ERC-721"
                  />

                  <label>Threshold (wei)</label>
                  <input className="bay-mono" value={threshold} onChange={(e) => setThreshold(e.target.value)} />
                </>
              )}
            </div>

            <div className="bay-step-row">
              <button className="bay-btn bay-btn-primary" disabled={!file || Boolean(busyStep)} onClick={() => void handleSeal()}>
                1. {gated ? 'Encrypt & VetKD IBE-Wrap' : 'Hash & Prepare'}
              </button>
              <button className="bay-btn" disabled={!sealed || Boolean(busyStep)} onClick={() => void handlePinSynapse()}>
                2. Pin to Filecoin (Synapse)
              </button>
              <button
                className="bay-btn bay-btn-primary"
                disabled={!sealed || !cid.trim() || Boolean(busyStep)}
                onClick={() => void handlePublishArkiv()}
              >
                3. Publish to Arkiv OP L3
              </button>
            </div>

            {sealed && (
              <div className="bay-form" style={{ marginTop: 10 }}>
                <label>Filecoin / IPFS CID</label>
                <input
                  className="bay-mono"
                  value={cid}
                  onChange={(e) => setCid(e.target.value)}
                  placeholder="Filled by Step 2 (Synapse) or paste existing pieceCID / IPFS CID"
                />
              </div>
            )}

            {busyStep && <div className="bay-alert info">{busyStep}</div>}
            {publishedKey && (
              <div className="bay-alert ok">
                ✓ Live on Arkiv OP L3! Entity Key: <code className="bay-mono">{publishedKey}</code>
              </div>
            )}

            {sealed && (
              <pre className="bay-pre">{JSON.stringify(sealed.envelopePreview, null, 2)}</pre>
            )}
          </div>
        )}

        {tab === 'daos' && (
          <div className="bay-panel">
            <h2>Active DataDAO Trackers ({daos.length})</h2>
            <table className="bay-table">
              <thead>
                <tr>
                  <th>DataDAO</th>
                  <th>Chain &amp; Token Contract</th>
                  <th>Releases</th>
                  <th>Standing</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {daos.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="bay-empty">
                      No token-gated DataDAOs indexed on this RPC yet.
                    </td>
                  </tr>
                ) : (
                  daos.map((d) => (
                    <tr key={d.gateId}>
                      <td>
                        <strong>{d.name}</strong> ({d.symbol})
                      </td>
                      <td className="bay-mono">
                        {d.chain}:{d.tokenAddress}
                      </td>
                      <td className="bay-num">{d.itemCount}</td>
                      <td>
                        {keyring[d.gateId] ? (
                          <span className="bay-tag ok">🔓 Unlocked</span>
                        ) : d.standing === 'member' ? (
                          <span className="bay-tag ok">✓ Member ({d.balanceFormatted})</span>
                        ) : (
                          <span className="bay-tag">Locked</span>
                        )}
                      </td>
                      <td>
                        <button
                          className="bay-btn bay-btn-xs"
                          onClick={() =>
                            void unlockGate({
                              gateId: d.gateId,
                              chain: d.chain,
                              chainId: d.chainId,
                              tokenAddress: d.tokenAddress,
                              threshold: d.threshold,
                            })
                          }
                        >
                          Unlock VetKD
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}

        {tab === 'settings' && (
          <div className="bay-panel">
            <h2>Tracker Network Settings</h2>
            <div className="bay-form">
              <label>Arkiv Preset</label>
              <select
                value={config.arkivPreset}
                onChange={(e) => {
                  const p = e.target.value as BayConfig['arkivPreset'];
                  updateConfig({
                    arkivPreset: p,
                    arkivRpcUrl:
                      p === 'rabdi'
                        ? 'https://rpc.rabdi.db-chain.testnet.arkiv.network'
                        : p === 'localhost'
                          ? 'http://127.0.0.1:8545'
                          : config.arkivRpcUrl,
                  });
                }}
              >
                <option value="rabdi">Arkiv Rabdi Testnet (Default)</option>
                <option value="localhost">Localhost (127.0.0.1:8545)</option>
                <option value="custom">Custom RPC</option>
              </select>

              <label>Arkiv RPC URL</label>
              <input
                className="bay-mono"
                value={config.arkivRpcUrl}
                onChange={(e) => updateConfig({ arkivPreset: 'custom', arkivRpcUrl: e.target.value })}
              />

              <label>IPFS / Filecoin Gateway</label>
              <input
                className="bay-mono"
                value={config.ipfsGateway}
                onChange={(e) => updateConfig({ ipfsGateway: e.target.value })}
              />

              <label>Haven-AOL Canister</label>
              <input
                className="bay-mono"
                value={config.aolCanisterId}
                onChange={(e) => updateConfig({ aolCanisterId: e.target.value })}
              />
            </div>
            <div className="bay-step-row">
              <button className="bay-btn bay-btn-primary" onClick={() => void refresh()}>
                Save &amp; Rescan Arkiv
              </button>
            </div>
          </div>
        )}
      </main>

      {toast && <div className="bay-toast">{toast}</div>}
    </div>
  );
}

export default App;
