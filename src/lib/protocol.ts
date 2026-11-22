import { createPublicClient } from '@arkiv-network/sdk';
import { rabdi } from '@arkiv-network/sdk/chains';
import { startsWith } from '@arkiv-network/sdk/query';
import { Actor, HttpAgent } from '@icp-sdk/core/agent';
import { IDL } from '@icp-sdk/core/candid';
import { DerivedPublicKey, EncryptedVetKey, TransportSecretKey } from '@icp-sdk/vetkeys';
import { createPublicClient as createEvmClient, formatUnits, http, type Address } from 'viem';

export type ReleaseCategory = 'audio' | 'video' | 'game' | 'file' | 'other';

export interface BayConfig {
  arkivPreset: 'rabdi' | 'localhost' | 'custom';
  arkivRpcUrl: string;
  arkivAccessKey: string;
  ipfsGateway: string;
  aolCanisterId: string;
  icpHost: string;
}

export const DEFAULT_BAY_CONFIG: BayConfig = {
  arkivPreset: 'rabdi',
  arkivRpcUrl: 'https://rpc.rabdi.db-chain.testnet.arkiv.network',
  arkivAccessKey: '',
  ipfsGateway: 'https://ipfs.io/ipfs/',
  aolCanisterId: 'gny6k-fqaaa-aaaab-ag3ra-cai',
  icpHost: 'https://icp-api.io',
};

export const CHAINS: Record<number, { id: number; variant: string; name: string; short: string; rpcUrl: string }> = {
  1: { id: 1, variant: 'ethereum', name: 'Ethereum Mainnet', short: 'ETH', rpcUrl: 'https://ethereum.publicnode.com' },
  8453: { id: 8453, variant: 'base', name: 'Base', short: 'BASE', rpcUrl: 'https://base-rpc.publicnode.com' },
  42161: { id: 42161, variant: 'arbitrum', name: 'Arbitrum One', short: 'ARB', rpcUrl: 'https://arbitrum-one-rpc.publicnode.com' },
  10: { id: 10, variant: 'optimism', name: 'Optimism', short: 'OP', rpcUrl: 'https://optimism-rpc.publicnode.com' },
  11155111: { id: 11155111, variant: 'sepolia', name: 'Ethereum Sepolia', short: 'SEP', rpcUrl: 'https://ethereum-sepolia-rpc.publicnode.com' },
  314159: { id: 314159, variant: 'calibration', name: 'Filecoin Calibration', short: 'tFIL', rpcUrl: 'https://api.calibration.node.glif.io/rpc/v1' },
};

const VARIANT_TO_ID: Record<string, number> = {
  ethereum: 1, mainnet: 1, eth: 1, 'eip155:1': 1,
  base: 8453, 'eip155:8453': 8453,
  arbitrum: 42161, arb: 42161, 'eip155:42161': 42161,
  optimism: 10, op: 10, 'eip155:10': 10,
  sepolia: 11155111, 'eip155:11155111': 11155111,
  calibration: 314159, filecoin: 314159, 'eip155:314159': 314159,
};

export function normalizeChainId(raw: unknown): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  const s = String(raw || '').trim().toLowerCase();
  if (VARIANT_TO_ID[s]) return VARIANT_TO_ID[s];
  const n = Number(s.replace(/^eip155:/, ''));
  return Number.isFinite(n) && n > 0 ? n : 8453;
}

export function chainVariantFor(chainId: number): string {
  return CHAINS[chainId]?.variant ?? `eip155:${chainId}`;
}

export interface BayRelease {
  entityKey: string;
  grp: string;
  category: ReleaseCategory;
  title: string;
  description: string;
  uploader: string;
  cid?: string;
  downloadUrl?: string;
  mimeType: string;
  sizeBytes?: number;
  createdAtBlock: number;
  createdAtMs: number;
  encrypted: boolean;
  gate?: {
    gateId: string;
    chain: string;
    chainId: number;
    tokenAddress: string;
    threshold: string;
  };
  gateJson?: Record<string, unknown>;
  epoch?: number;
  attested: boolean;
  tags: string[];
}

export interface DaoTrackerEntry {
  gateId: string;
  chain: string;
  chainId: number;
  tokenAddress: string;
  threshold: string;
  name: string;
  symbol: string;
  itemCount: number;
  standing: 'member' | 'locked' | 'unchecked';
  balanceFormatted?: string;
}

export interface Eip1193Provider {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  on?: (event: string, listener: (...args: unknown[]) => void) => void;
}

const STORAGE_KEY = 'haven-bay:config:v1';

export function loadBayConfig(): BayConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_BAY_CONFIG;
    return { ...DEFAULT_BAY_CONFIG, ...(JSON.parse(raw) as Partial<BayConfig>) };
  } catch {
    return DEFAULT_BAY_CONFIG;
  }
}

export function saveBayConfig(cfg: BayConfig): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
  } catch {
    // ignore
  }
}

function unwrapAttr(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'object' && 'value' in (v as Record<string, unknown>)) {
    return String((v as { value: unknown }).value ?? '');
  }
  return String(v);
}

function decodePayload(raw: unknown): Record<string, unknown> {
  if (!raw) return {};
  try {
    if (raw instanceof Uint8Array) return JSON.parse(new TextDecoder().decode(raw)) as Record<string, unknown>;
    if (typeof raw === 'string') {
      const t = raw.trim();
      if (t.startsWith('{')) return JSON.parse(t) as Record<string, unknown>;
      const bin = atob(t);
      const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      return JSON.parse(new TextDecoder().decode(u8)) as Record<string, unknown>;
    }
    if (typeof raw === 'object' && 'value' in (raw as Record<string, unknown>)) {
      return decodePayload((raw as { value: unknown }).value);
    }
  } catch {
    return {};
  }
  return {};
}

function inferCategory(grp: string, mime: string): ReleaseCategory {
  if (grp.includes('audio') || mime.startsWith('audio/')) return 'audio';
  if (grp.includes('video') || mime.startsWith('video/')) return 'video';
  if (grp.includes('game') || grp.includes('dance')) return 'game';
  if (grp.includes('file')) return 'file';
  return 'other';
}

export function buildGatewayUrl(cid: string | undefined, gateway: string): string | undefined {
  if (!cid) return undefined;
  const t = cid.trim();
  if (!t) return undefined;
  if (t.startsWith('http://') || t.startsWith('https://')) return t;
  const clean = t.replace(/^ipfs:\/\//i, '').replace(/^\/ipfs\//i, '');
  return `${gateway.endsWith('/') ? gateway : `${gateway}/`}${clean}`;
}

export async function scanArkivReleases(config: BayConfig): Promise<{
  releases: BayRelease[];
  blockNumber: number | null;
  elapsedMs: number;
  error?: string;
}> {
  const t0 = performance.now();
  const rpcUrl = config.arkivRpcUrl.trim() || DEFAULT_BAY_CONFIG.arkivRpcUrl;
  const baseChain = rabdi({ accessKey: config.arkivAccessKey || '' });
  const chain =
    config.arkivPreset === 'rabdi' ? baseChain : { ...baseChain, rpcUrls: { default: { http: [rpcUrl] } } };

  try {
    const client = createPublicClient({ chain, transport: http(rpcUrl) });
    const blockPromise = client.getBlockNumber().catch(() => null);
    const page = await client
      .select({
        $key: true,
        $owner: true,
        $creator: true,
        $createdAt: true,
        $attributes: true,
        payload: true,
      })
      .where(startsWith('grp', 'haven.'))
      .limit(150)
      .fetch();

    const rows = ((page as unknown as { entities?: Record<string, unknown>[] }).entities ??
      (Array.isArray(page) ? page : [])) as Record<string, unknown>[];
    const blockNumber = await blockPromise;

    const releases: BayRelease[] = [];
    for (const row of rows) {
      const attrsRaw = row.$attributes ?? row.attributes;
      const attrs: Record<string, string> = {};
      if (Array.isArray(attrsRaw)) {
        for (const a of attrsRaw) {
          if (a && typeof a === 'object' && 'key' in a) {
            attrs[String((a as { key: unknown }).key)] = unwrapAttr((a as { value: unknown }).value);
          }
        }
      } else if (attrsRaw && typeof attrsRaw === 'object') {
        for (const [k, v] of Object.entries(attrsRaw as Record<string, unknown>)) attrs[k] = unwrapAttr(v);
      }

      const payload = decodePayload(row.payload);
      const grp = attrs.grp || String(payload.grp || '');
      if (!grp.startsWith('haven.')) continue;

      const entityKey = String(row.$key || row.key || '');
      const uploader = String(row.$owner || row.owner || row.$creator || attrs.creator || 'Anonymous').toLowerCase();
      const mimeType = String(payload.mimeType || payload.mime_type || attrs.mime || 'application/octet-stream');
      const category = inferCategory(grp, mimeType);
      const cid = String(
        payload.cid || payload.pieceCid || payload.piece || payload.mediaCid || payload.videoCid || payload.audioCid || attrs.cid || '',
      ) || undefined;

      // Include all file/media/game releases or anything with a CID
      if (!cid && category === 'other') continue;

      const gateToken =
        attrs.gate_token ||
        String((payload.gate as Record<string, unknown> | undefined)?.tokenAddress ||
          (payload.gate as Record<string, unknown> | undefined)?.token || '');
      const gateChainRaw =
        attrs.gate_chain || String((payload.gate as Record<string, unknown> | undefined)?.chain || '');
      const gateThreshold =
        attrs.gate_threshold || String((payload.gate as Record<string, unknown> | undefined)?.threshold || '1');

      let gate: BayRelease['gate'];
      if (gateToken && gateToken.startsWith('0x') && gateToken.length >= 40) {
        const cidNum = normalizeChainId(gateChainRaw);
        const variant = chainVariantFor(cidNum);
        gate = {
          gateId: `${variant}:${gateToken.toLowerCase()}`,
          chain: variant,
          chainId: cidNum,
          tokenAddress: gateToken.toLowerCase(),
          threshold: gateThreshold,
        };
      }

      const attn = payload.attn as Record<string, unknown> | undefined;
      releases.push({
        entityKey,
        grp,
        category,
        title: String(payload.title || payload.name || attrs.title || `Haven Release ${entityKey.slice(0, 10)}`),
        description: String(payload.description || payload.caption || ''),
        uploader,
        cid,
        downloadUrl: buildGatewayUrl(cid, config.ipfsGateway),
        mimeType,
        sizeBytes: Number(payload.sizeBytes || payload.size || 0) || undefined,
        createdAtBlock: Number(row.$createdAt || row.createdAtBlock || 0),
        createdAtMs: Number(payload.createdAt || payload.timestamp || 0) || Date.now(),
        encrypted: Boolean(gate || payload.encrypted || attrs.encrypted === 'true'),
        gate,
        gateJson: (payload.gateJson || payload.aol || payload.enc) as Record<string, unknown> | undefined,
        epoch: typeof payload.epoch === 'number' ? payload.epoch : undefined,
        attested: Boolean(attn && (attn.sig || attn.signature || attn.verified !== false)),
        tags: Array.isArray(payload.tags) ? payload.tags.map(String) : [],
      });
    }

    releases.sort((a, b) => b.createdAtBlock - a.createdAtBlock || b.createdAtMs - a.createdAtMs);
    return {
      releases,
      blockNumber: blockNumber != null ? Number(blockNumber) : null,
      elapsedMs: Math.round(performance.now() - t0),
    };
  } catch (err) {
    return {
      releases: [],
      blockNumber: null,
      elapsedMs: Math.round(performance.now() - t0),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

const ERC20_ABI = [
  { name: 'name', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { name: 'symbol', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { name: 'decimals', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
] as const;

export async function buildAndInspectDaos(
  releases: BayRelease[],
  walletAddress: string | null,
): Promise<DaoTrackerEntry[]> {
  const map = new Map<string, DaoTrackerEntry>();
  for (const r of releases) {
    if (!r.gate) continue;
    const hit = map.get(r.gate.gateId);
    if (hit) hit.itemCount += 1;
    else {
      map.set(r.gate.gateId, {
        gateId: r.gate.gateId,
        chain: r.gate.chain,
        chainId: r.gate.chainId,
        tokenAddress: r.gate.tokenAddress,
        threshold: r.gate.threshold,
        name: `${CHAINS[r.gate.chainId]?.short || r.gate.chain.toUpperCase()} ${r.gate.tokenAddress.slice(0, 6)}…${r.gate.tokenAddress.slice(-4)}`,
        symbol: CHAINS[r.gate.chainId]?.short || 'TOK',
        itemCount: 1,
        standing: 'unchecked',
      });
    }
  }
  const list = Array.from(map.values()).sort((a, b) => b.itemCount - a.itemCount);
  if (!walletAddress) return list;

  return Promise.all(
    list.slice(0, 20).map(async (dao) => {
      const chainMeta = CHAINS[dao.chainId];
      if (!chainMeta) return dao;
      try {
        const client = createEvmClient({ transport: http(chainMeta.rpcUrl) });
        const addr = dao.tokenAddress as Address;
        const [name, symbol, decimals, bal] = await Promise.all([
          client.readContract({ address: addr, abi: ERC20_ABI, functionName: 'name' }).catch(() => null),
          client.readContract({ address: addr, abi: ERC20_ABI, functionName: 'symbol' }).catch(() => null),
          client.readContract({ address: addr, abi: ERC20_ABI, functionName: 'decimals' }).catch(() => 18),
          client
            .readContract({ address: addr, abi: ERC20_ABI, functionName: 'balanceOf', args: [walletAddress as Address] })
            .catch(() => null),
        ]);
        const dec = typeof decimals === 'number' ? decimals : 18;
        let standing: DaoTrackerEntry['standing'] = 'unchecked';
        let balanceFormatted: string | undefined;
        if (bal != null) {
          balanceFormatted = formatUnits(bal, dec);
          let thresh = 1n;
          try {
            thresh = BigInt(dao.threshold);
          } catch {
            thresh = 1n;
          }
          standing = bal >= thresh ? 'member' : 'locked';
        }
        return {
          ...dao,
          name: typeof name === 'string' && name.trim() ? name.trim() : dao.name,
          symbol: typeof symbol === 'string' && symbol.trim() ? symbol.trim() : dao.symbol,
          standing,
          balanceFormatted,
        };
      } catch {
        return dao;
      }
    }),
  );
}

const AOL_IDL: IDL.InterfaceFactory = ({ IDL: idl }) =>
  idl.Service({
    encrypted_key_for_gate: idl.Func(
      [
        idl.Record({
          chain_id: idl.Nat64,
          token_address: idl.Text,
          threshold: idl.Text,
          epoch: idl.Nat64,
          requester: idl.Text,
          signature: idl.Text,
          transport_public_key: idl.Vec(idl.Nat8),
        }),
      ],
      [
        idl.Variant({
          Ok: idl.Record({
            encrypted_key: idl.Vec(idl.Nat8),
            public_key: idl.Vec(idl.Nat8),
            identity: idl.Vec(idl.Nat8),
          }),
          Err: idl.Text,
        }),
      ],
      [],
    ),
  });

export async function unlockGateStandalone(params: {
  config: BayConfig;
  provider: Eip1193Provider;
  address: string;
  chainId: number;
  tokenAddress: string;
  threshold: string;
  epoch?: number;
}): Promise<{ epoch: number; rawKey: Uint8Array }> {
  const epoch = params.epoch ?? Math.floor(Date.now() / 1000 / 86400);
  const typedData = {
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
      ],
      GateRequestV3: [
        { name: 'chainId', type: 'uint256' },
        { name: 'tokenAddress', type: 'address' },
        { name: 'threshold', type: 'string' },
        { name: 'epoch', type: 'uint64' },
        { name: 'requester', type: 'address' },
      ],
    },
    primaryType: 'GateRequestV3',
    domain: { name: 'Haven-AOL', version: '3', chainId: params.chainId },
    message: {
      chainId: params.chainId,
      tokenAddress: params.tokenAddress,
      threshold: params.threshold,
      epoch,
      requester: params.address,
    },
  };
  const signature = String(
    await params.provider.request({
      method: 'eth_signTypedData_v4',
      params: [params.address, JSON.stringify(typedData)],
    }),
  );
  const tsk = TransportSecretKey.random();
  const agent = await HttpAgent.create({ host: params.config.icpHost || 'https://icp-api.io' });
  const actor = Actor.createActor(AOL_IDL, {
    agent,
    canisterId: params.config.aolCanisterId,
  }) as unknown as {
    encrypted_key_for_gate: (args: unknown) => Promise<
      | { Ok: { encrypted_key: Uint8Array | number[]; public_key: Uint8Array | number[]; identity: Uint8Array | number[] } }
      | { Err: string }
    >;
  };
  const res = await actor.encrypted_key_for_gate({
    chain_id: BigInt(params.chainId),
    token_address: params.tokenAddress.toLowerCase(),
    threshold: params.threshold,
    epoch: BigInt(epoch),
    requester: params.address.toLowerCase(),
    signature,
    transport_public_key: Array.from(tsk.publicKeyBytes()),
  });
  if ('Err' in res) throw new Error(res.Err);
  const vetKey = EncryptedVetKey.deserialize(new Uint8Array(res.Ok.encrypted_key)).decryptAndVerify(
    tsk,
    DerivedPublicKey.deserialize(new Uint8Array(res.Ok.public_key)),
    new Uint8Array(res.Ok.identity),
  );
  const rawKey = new Uint8Array(await vetKey.deriveSymmetricKey('haven-aes-256-gcm', 32));
  return { epoch, rawKey };
}

export async function decryptBytesAesGcm(ciphertext: Uint8Array, rawKey: Uint8Array): Promise<Uint8Array> {
  const keyBuf = new ArrayBuffer(rawKey.byteLength);
  new Uint8Array(keyBuf).set(rawKey);
  const aesKey = await crypto.subtle.importKey('raw', keyBuf, { name: 'AES-GCM' }, false, ['decrypt']);
  const ivBuf = new ArrayBuffer(12);
  new Uint8Array(ivBuf).set(ciphertext.subarray(0, 12));
  const bodyBuf = new ArrayBuffer(ciphertext.byteLength - 12);
  new Uint8Array(bodyBuf).set(ciphertext.subarray(12));
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ivBuf }, aesKey, bodyBuf);
  return new Uint8Array(plain);
}
