import { createWalletClient as createArkivWalletClient } from '@arkiv-network/sdk';
import { rabdi } from '@arkiv-network/sdk/chains';
import { bytes, defineSchema, i32, str, u256, type Schema } from '@arkiv-network/sdk/schema';
import { ExpirationTime } from '@arkiv-network/sdk/utils';
import { Synapse } from '@filoz/synapse-sdk';
import { getChain as getSynapseChain } from '@filoz/synapse-core/chains';
import { Actor, HttpAgent } from '@icp-sdk/core/agent';
import { IDL } from '@icp-sdk/core/candid';
import { DerivedPublicKey, IbeCiphertext, IbeIdentity, IbeSeed } from '@icp-sdk/vetkeys';
import { custom, type Address } from 'viem';
import { chainVariantFor, type BayConfig, type Eip1193Provider } from './protocol';

export type HavenUploadGroup =
  | 'haven.audio.full'
  | 'haven.video.full'
  | 'haven.game.dance.pack'
  | 'haven.file.full';

export const HAVEN_UPLOAD_SCHEMA: Schema = defineSchema({
  grp: str().indexed(),
  title: str().optional(),
  gate_type: i32(),
  gate_token: str().optional(),
  gate_chain: i32().optional(),
  gate_threshold: u256().optional(),
  gate_epoch: i32().optional(),
  sha256_ct: str().indexed().optional(),
  content_type: str(),
  payload: bytes(),
});

export interface UploadDraft {
  file: File;
  grp: HavenUploadGroup;
  title: string;
  artist: string;
  album: string;
  description: string;
  tags: string[];
  gated: boolean;
  chainId: number;
  tokenAddress: string;
  threshold: string;
}

export interface SealedRelease {
  sha256Hex: string;
  sha256CtHex: string;
  encrypted: boolean;
  ciphertextBytes: Uint8Array;
  ivBase64?: string;
  ibeWrappedKeyBase64?: string;
  epoch?: number;
  mimeType: string;
  draft: UploadDraft;
  envelopePreview: {
    attributes: Record<string, string | number>;
    payload: Record<string, unknown>;
  };
}

function toHex(arr: Uint8Array): string {
  return Array.from(arr)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function toBase64(arr: Uint8Array): string {
  let s = '';
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
  return btoa(s);
}

const AOL_PUBKEY_IDL: IDL.InterfaceFactory = ({ IDL: idl }) =>
  idl.Service({
    vetkd_public_key: idl.Func([], [idl.Variant({ Ok: idl.Vec(idl.Nat8), Err: idl.Text })], []),
  });

async function tryIbeWrapKey(
  config: BayConfig,
  chainVariant: string,
  tokenAddress: string,
  threshold: string,
  epoch: number,
  rawAesKey: Uint8Array,
): Promise<string | undefined> {
  try {
    const agent = await HttpAgent.create({ host: config.icpHost || 'https://icp-api.io' });
    const actor = Actor.createActor(AOL_PUBKEY_IDL, {
      agent,
      canisterId: config.aolCanisterId,
    }) as unknown as {
      vetkd_public_key: () => Promise<{ Ok: Uint8Array | number[] } | { Err: string }>;
    };
    const res = await actor.vetkd_public_key();
    if ('Err' in res) return undefined;
    const dpk = DerivedPublicKey.deserialize(new Uint8Array(res.Ok));
    const identityStr = `accessol:v3:${chainVariant}:${tokenAddress.toLowerCase()}:${threshold}:${epoch}`;
    const idHash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identityStr)));
    const ct = IbeCiphertext.encrypt(dpk, IbeIdentity.fromBytes(idHash), rawAesKey, IbeSeed.random());
    return toBase64(ct.serialize());
  } catch {
    return undefined;
  }
}

export async function sealUploadFile(
  draft: UploadDraft,
  uploaderAddress: string | null,
  config: BayConfig,
): Promise<SealedRelease> {
  const plainBuf = await draft.file.arrayBuffer();
  const sha256Hex = toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', plainBuf)));
  const mimeType = draft.file.type || 'application/octet-stream';
  const chainVariant = chainVariantFor(draft.chainId);
  const epoch = Math.floor(Date.now() / 1000 / 86400);

  let ciphertextBytes: Uint8Array;
  let ivBase64: string | undefined;
  let ibeWrappedKeyBase64: string | undefined;

  if (draft.gated) {
    const rawKey = crypto.getRandomValues(new Uint8Array(32));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const keyBuf = new ArrayBuffer(32);
    new Uint8Array(keyBuf).set(rawKey);
    const ivBuf = new ArrayBuffer(12);
    new Uint8Array(ivBuf).set(iv);

    const aesKey = await crypto.subtle.importKey('raw', keyBuf, { name: 'AES-GCM' }, false, ['encrypt']);
    const enc = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: ivBuf }, aesKey, plainBuf));
    ciphertextBytes = new Uint8Array(12 + enc.byteLength);
    ciphertextBytes.set(iv, 0);
    ciphertextBytes.set(enc, 12);
    ivBase64 = toBase64(iv);

    if (draft.tokenAddress.trim()) {
      ibeWrappedKeyBase64 = await tryIbeWrapKey(
        config,
        chainVariant,
        draft.tokenAddress.trim(),
        draft.threshold.trim() || '1',
        epoch,
        rawKey,
      );
    }
    rawKey.fill(0);
  } else {
    ciphertextBytes = new Uint8Array(plainBuf);
  }

  const ctBuf = new ArrayBuffer(ciphertextBytes.byteLength);
  new Uint8Array(ctBuf).set(ciphertextBytes);
  const sha256CtHex = toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', ctBuf)));

  const attributes: Record<string, string | number> = {
    grp: draft.grp,
    title: draft.title.trim() || draft.file.name,
    gate_type: draft.gated ? 3 : 0,
    sha256_ct: sha256CtHex,
  };
  if (draft.gated && draft.tokenAddress.trim()) {
    attributes.gate_chain = draft.chainId;
    attributes.gate_token = draft.tokenAddress.trim().toLowerCase();
    attributes.gate_threshold = draft.threshold.trim() || '1';
    attributes.gate_epoch = epoch;
  }

  const payload: Record<string, unknown> = {
    grp: draft.grp,
    title: draft.title.trim() || draft.file.name,
    artist: draft.artist.trim() || (uploaderAddress ? `${uploaderAddress.slice(0, 6)}…${uploaderAddress.slice(-4)}` : 'Anonymous'),
    album: draft.album.trim() || (draft.gated ? `DAO ${draft.tokenAddress.slice(0, 8)}` : 'Public Commons'),
    description: draft.description.trim(),
    fileName: draft.file.name,
    mimeType,
    sizeBytes: draft.file.size,
    sha256: sha256Hex,
    sha256Ct: sha256CtHex,
    encrypted: draft.gated,
    tags: draft.tags,
    createdAt: Date.now(),
    ...(draft.gated
      ? {
          gate: {
            version: 3,
            chain: chainVariant,
            chainId: draft.chainId,
            tokenAddress: draft.tokenAddress.trim().toLowerCase(),
            threshold: draft.threshold.trim() || '1',
            epoch,
            ...(ibeWrappedKeyBase64 ? { ibeCiphertext: ibeWrappedKeyBase64 } : {}),
          },
          epoch,
          enc: { alg: 'AES-256-GCM', iv: ivBase64, commitment: sha256CtHex },
        }
      : {}),
  };

  return {
    sha256Hex,
    sha256CtHex,
    encrypted: draft.gated,
    ciphertextBytes,
    ivBase64,
    ibeWrappedKeyBase64,
    epoch: draft.gated ? epoch : undefined,
    mimeType,
    draft,
    envelopePreview: { attributes, payload },
  };
}

export async function pinToFilecoinSynapse(params: {
  provider: Eip1193Provider;
  address: string;
  bytes: Uint8Array;
  onStatus?: (msg: string) => void;
}): Promise<{ pieceCid: string; size: number }> {
  params.onStatus?.('Initializing Filecoin Onchain Cloud (Synapse SDK)…');
  const synapse = await Synapse.create({
    account: params.address as Address,
    transport: custom(params.provider as never),
    chain: getSynapseChain(8453) as unknown as NonNullable<Parameters<typeof Synapse.create>[0]['chain']>,
    withCDN: true,
    source: 'haven-bay',
  });
  params.onStatus?.(`Seeding ${params.bytes.byteLength.toLocaleString()} bytes to Filecoin…`);
  const res = await synapse.storage.upload(params.bytes);
  const pieceCid = String(
    (res as unknown as { pieceCid?: unknown; commp?: unknown }).pieceCid ??
      (res as unknown as { commp?: unknown }).commp ??
      '',
  );
  if (!pieceCid) throw new Error('Synapse upload completed without returning a pieceCid.');
  return { pieceCid, size: params.bytes.byteLength };
}

export async function publishToArkiv(params: {
  provider: Eip1193Provider;
  address: string;
  config: BayConfig;
  sealed: SealedRelease;
  cid: string;
  onStatus?: (msg: string) => void;
}): Promise<{ entityKey: string }> {
  const chain = rabdi({ accessKey: params.config.arkivAccessKey || '' });
  params.onStatus?.(`Switching wallet to Arkiv (${chain.name})…`);
  try {
    await params.provider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: `0x${chain.id.toString(16)}` }],
    });
  } catch {
    // wallet may already be on Rabdi
  }

  const walletClient = createArkivWalletClient({
    account: params.address as Address,
    chain,
    transport: custom(params.provider as never),
  });

  const payloadBytes = new TextEncoder().encode(
    JSON.stringify({
      ...params.sealed.envelopePreview.payload,
      cid: params.cid,
      pieceCid: params.cid,
      piece: params.cid,
    }),
  );

  const values: Record<string, unknown> = {
    grp: params.sealed.draft.grp,
    title: params.sealed.draft.title.trim() || params.sealed.draft.file.name,
    gate_type: params.sealed.encrypted ? 3 : 0,
    sha256_ct: params.sealed.sha256CtHex,
    content_type: 'application/json',
    payload: payloadBytes,
  };
  if (params.sealed.encrypted && params.sealed.draft.tokenAddress.trim()) {
    values.gate_chain = params.sealed.draft.chainId;
    values.gate_token = params.sealed.draft.tokenAddress.trim().toLowerCase();
    values.gate_threshold = BigInt(params.sealed.draft.threshold.trim() || '1');
    if (params.sealed.epoch != null) values.gate_epoch = params.sealed.epoch;
  }

  params.onStatus?.('Awaiting wallet signature to index entity on Arkiv OP L3…');
  const res = await (
    walletClient as unknown as {
      createEntity: (
        schema: Schema,
        vals: Record<string, unknown>,
        opts: { expiration: ReturnType<typeof ExpirationTime.fromWeeks> },
      ) => Promise<{ entityKey: string }>;
    }
  ).createEntity(HAVEN_UPLOAD_SCHEMA, values, {
    expiration: ExpirationTime.fromWeeks(12),
  });

  return { entityKey: String(res.entityKey) };
}
