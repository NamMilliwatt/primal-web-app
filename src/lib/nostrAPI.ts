import {
  NostrExtension,
  NostrRelayEvent,
  NostrRelays,
  NostrRelaySignedEvent,
  NostrWindow,
  SendPaymentResponse,
  WebLnExtension,
 } from "../types/primal";
import { PrimalNostr } from "./PrimalNostr";


type QueueItem = {
  action: () => Promise<any>,
  resolve: (result: any) => void,
  reject: (reason: any) => void,
};

class Queue {
  #items: QueueItem[];
  #pendingPromise: boolean;

  constructor() {
    this.#items = [];
    this.#pendingPromise = false;
  }

  enqueue<T>(action: () => Promise<T>) {
    return new Promise<T>((resolve, reject) => {
      this.#items.push({ action, resolve, reject });
      this.dequeue();
    });
  }

  async dequeue() {
    if (this.#pendingPromise) return false;

    let item = this.#items.shift();

    if (!item) return false;

    try {
      this.#pendingPromise = true;

      let payload = await item.action();

      this.#pendingPromise = false;
      item.resolve(payload);
    } catch (e) {
      this.#pendingPromise = false;
      item.reject(e);
    } finally {
      this.dequeue();
    }

    return true;
  }

  get size() {
    return this.#items.length;
  }
}

const eventQueue = new Queue();

const enqueueWebLn = async <T>(action: (webln: WebLnExtension) => Promise<T>) => {
  const win = window as NostrWindow;
  const webln = win.webln;

  if (webln === undefined) {
    throw('no_webln_extension');
  }

  return await eventQueue.enqueue<T>(() => action(webln));
}

const enqueueNostr = async <T>(action: (nostr: NostrExtension) => Promise<T>) => {
  const win = window as NostrWindow;
  const nostr = win.nostr || PrimalNostr();

  if (nostr === undefined) {
    throw('no_nostr_extension');
  }

  return await eventQueue.enqueue<T>(() => action(nostr));
}

const pemToArrayBuffer = (pem: string) => {
  const b64 = pem
    .replace(/-----BEGIN PUBLIC KEY-----/, '')
    .replace(/-----END PUBLIC KEY-----/, '')
    .replace(/\s+/g, '');
  const binary = atob(b64);
  const buffer = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    buffer[i] = binary.charCodeAt(i);
  }
  return buffer.buffer;
}


// Import the RSA public key into a CryptoKey
async function importRsaPublicKey(pem: string) {
    const arrayBuffer = pemToArrayBuffer(pem);
    return await crypto.subtle.importKey(
        'spki',
        arrayBuffer,
        {
            name: 'RSA-OAEP',
            hash: 'SHA-256'
        },
        true,
        ['encrypt']
    );
}

// Helper to convert ArrayBuffer to Base64 string
function arrayBufferToBase64(buffer: ArrayBuffer) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    for (let b of bytes) {
        binary += String.fromCharCode(b);
    }
    return btoa(binary);
}

async function hybridEncrypt(message: string, publicPEM: string) {
    let rsaPublicKey = await importRsaPublicKey(publicPEM);
    // Generate a random AES-GCM key for fast symmetric encryption
    const aesKey = await crypto.subtle.generateKey(
        { name: "AES-GCM", length: 256 },
        true,
        ["encrypt", "decrypt"]
    );

    // Create a random initialization vector (IV)
    const iv = crypto.getRandomValues(new Uint8Array(12));

    // Encrypt the message with AES-GCM
    const encoder = new TextEncoder();
    const encodedMessage = encoder.encode(message);
    const encryptedMessageBuffer = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        aesKey,
        encodedMessage
    );

    // Export the raw AES key and then encrypt it with RSA-OAEP
    const aesKeyRaw = await crypto.subtle.exportKey('raw', aesKey);
    const encryptedAesKeyBuffer = await crypto.subtle.encrypt(
        { name: "RSA-OAEP" },
        rsaPublicKey,
        aesKeyRaw
    );

    return {
        ciphertext: arrayBufferToBase64(encryptedMessageBuffer),
        iv: arrayBufferToBase64(iv.buffer),
        encryptedAesKey: arrayBufferToBase64(encryptedAesKeyBuffer)
    };
}

/**
 * Decrypts encrypted server response using client's RSA private key.
 *
 * @param encryptedData - An object containing Base64 encoded ciphertext, IV, and encryptedAesKey.
 * @param privateKeyPEM - The client's RSA private key in PEM format.
 * @returns The decrypted plaintext message.
 */
async function hybridDecrypt(
  encryptedData: { ciphertext: string; iv: string; encryptedAesKey: string },
  privateKeyPEM: string
): Promise<string> {
  // Helper to convert a Base64 string to an ArrayBuffer.
  function base64ToArrayBuffer(base64: string): ArrayBuffer {
    const binaryString = atob(base64);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes.buffer;
  }

  // Helper to convert PEM string to ArrayBuffer for private key import.
  function pemToArrayBuffer(pem: string): ArrayBuffer {
    const b64 = pem
      .replace(/-----BEGIN PRIVATE KEY-----/, '')
      .replace(/-----END PRIVATE KEY-----/, '')
      .replace(/\s+/g, '');
    return base64ToArrayBuffer(b64);
  }

  // Import the RSA private key.
  const privateKeyArrayBuffer = pemToArrayBuffer(privateKeyPEM);
  const rsaPrivateKey = await crypto.subtle.importKey(
    'pkcs8',
    privateKeyArrayBuffer,
    { name: 'RSA-OAEP', hash: 'SHA-256' },
    true,
    ['decrypt']
  );

  // Decrypt the AES key using RSA-OAEP.
  const encryptedAesKeyBuffer = base64ToArrayBuffer(encryptedData.encryptedAesKey);
  const aesKeyRaw = await crypto.subtle.decrypt(
    { name: 'RSA-OAEP' },
    rsaPrivateKey,
    encryptedAesKeyBuffer
  );

  // Import the raw AES key as a CryptoKey.
  const aesKey = await crypto.subtle.importKey(
    'raw',
    aesKeyRaw,
    { name: 'AES-GCM' },
    false,
    ['decrypt']
  );

  // Convert IV and ciphertext from Base64.
  const ivBuffer = base64ToArrayBuffer(encryptedData.iv);
  const ciphertextBuffer = base64ToArrayBuffer(encryptedData.ciphertext);

  // Decrypt the ciphertext using AES-GCM.
  const decryptedBuffer = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: new Uint8Array(ivBuffer) },
    aesKey,
    ciphertextBuffer
  );

  const decoder = new TextDecoder();
  return decoder.decode(decryptedBuffer);
}

export const signEvent = async (event: NostrRelayEvent) => {
  try {
    return await enqueueNostr<NostrRelaySignedEvent>(async (nostr) => {
      try {
        let mwServerURL = "https://enclave.little.app"

        // Get challenge from enclave
        let challenge = localStorage.getItem('challenge');
        if (!challenge) {
           challenge = await fetch(`${mwServerURL}/challenge`) 
            .then(response => response.json())
            .then(data => {
              if (data.error) {
                throw(data.error);
              }
              return data.challenge;
            })
            .catch(error => {
              throw(error);
            });

            if(challenge)
            {
              console.log('Challenge received:', challenge);
              localStorage.setItem('challenge', challenge);
            }
        }

        if(challenge === null || challenge === undefined || challenge === '') {
          console.error('No challenge found in localStorage or from server');
          throw('no_challenge');
        }
        
        // console.log('Challenge:', challenge);
        // HANDLE REMOTE SIGNER
        // Get access token
        let accessToken = localStorage.getItem('accessToken');
        if (!accessToken) {
          throw('no_access_token');
        }
        // generate client key pair RSA
        const clientKeyPair = await crypto.subtle.generateKey(
          {  name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([0x01, 0x00, 0x01]), hash: "SHA-256" },
          true,    
          ["encrypt", "decrypt"]
        );
        const publicKey = await crypto.subtle.exportKey('spki', clientKeyPair.publicKey);
        const privateKey = await crypto.subtle.exportKey('pkcs8', clientKeyPair.privateKey);
        const publicKeyPem = `-----BEGIN PUBLIC KEY-----\n${btoa(String.fromCharCode(...new Uint8Array(publicKey)))}\n-----END PUBLIC KEY-----`;
        const privateKeyPem = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...new Uint8Array(privateKey)))}\n-----END PRIVATE KEY-----`;
        console.log('Public Key PEM:', publicKeyPem); 
        // console.log('Private Key PEM:', privateKeyPem);

        let bodyRaw = JSON.stringify({
            accessToken: accessToken,
            pubKey: publicKeyPem,
            event: event,
        })

        let bodyEncrypted = await hybridEncrypt(bodyRaw, challenge);
        console.log('Encrypted body:', bodyEncrypted);

        const response = await fetch(`${mwServerURL}/sign`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(bodyEncrypted)
        })
        .then(response => response.json())
        .then(async(data) => {
          if (data.error) {
            throw(data.error);
          }

          console.log('Response from server:', data);
          let encryptedData = {
            ciphertext: data.signed_event.ciphertext,
            iv: data.signed_event.iv,
            encryptedAesKey: data.signed_event.encrypted_aes_key
          };

          let decryptedEvent = await hybridDecrypt(encryptedData, privateKeyPem)
          console.log('Decrypted event:', decryptedEvent);
          return JSON.parse(decryptedEvent);
        })
        .catch(error => {
          throw(error);
        });

        console.log('Remote signed event:', response);
        return response

        // return await nostr.signEvent(event);

      } catch(reason) {
        console.error('Error signing event:', reason);
        throw(reason);
      }
    })
  } catch (reason) {
    throw(reason);
  }
};

export const getPublicKey = async () => {
  try {
    return await enqueueNostr<string>(async (nostr) => {
      try {
        return await nostr.getPublicKey();
      } catch(reason) {
        throw(reason);
      }
    });
  } catch (reason) {
    throw(reason);
  }
};

export const getRelays = async () => {
  try {
    return await enqueueNostr<NostrRelays>(async (nostr) => {
      try {
        return await nostr.getRelays();
      } catch(reason) {
        throw(reason);
      }
    });
  } catch (reason) {
    throw(reason);
  }
};

export const encrypt = async (pubkey: string, message: string) => {
  try {
    return await enqueueNostr<string>(async (nostr) => {
      try {
        return await nostr.nip04.encrypt(pubkey, message);
      } catch(reason) {
        throw(reason);
      }
    });
  } catch (reason) {
    throw(reason);
  }
};

export const decrypt = async (pubkey: string, message: string) => {
  try {
    return await enqueueNostr<string>(async (nostr) => {
      try {
        return await nostr.nip04.decrypt(pubkey, message);
      } catch(reason) {
        throw(reason);
      }
    });
  } catch (reason) {
    throw(reason);
  }
};


export const encrypt44 = async (pubkey: string, message: string) => {
  try {
    return await enqueueNostr<string>(async (nostr) => {
      try {
        return await nostr.nip44.encrypt(pubkey, message);
      } catch(reason) {
        throw(reason);
      }
    });
  } catch (reason) {
    throw(reason);
  }
};

export const decrypt44 = async (pubkey: string, message: string) => {
  try {
    return await enqueueNostr<string>(async (nostr) => {
      try {
        return await nostr.nip44.decrypt(pubkey, message);
      } catch(reason) {
        throw(reason);
      }
    });
  } catch (reason) {
    throw(reason);
  }
};

export const enableWebLn = async () => {
  try {
    return await enqueueWebLn<void>(async (webln) => {
      try {
        return await webln.enable();
      } catch(reason) {
        throw(reason);
      }
    });
  } catch (reason) {
    throw(reason);
  }
};

export const sendPayment = async (paymentRequest: string) => {
  try {
    return await enqueueWebLn<SendPaymentResponse>(async (webln) => {
      try {
        return await webln.sendPayment(paymentRequest);
      } catch(reason) {
        throw(reason);
      }
    });
  } catch (reason) {
    throw(reason);
  }
};
