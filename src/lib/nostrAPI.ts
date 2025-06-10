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

// const encryptAESGCMWithRSA = async (rsaPubKey: string, content: string) => {
//     try {
//       const publicKeyArrayBuffer = pemToArrayBuffer(rsaPubKey);
//       const rsaPublicKey = await crypto.subtle.importKey(
//         'spki',
//         publicKeyArrayBuffer,
//         { 
//           name: 'RSA-OAEP', 
//           hash: 'SHA-256' 
//         },
//         true,
//         ['encrypt']
//       );

//       const encoder = new TextEncoder();
//       const contentBuffer = encoder.encode(content);

//       console.log("Content to encrypt:", content);

//       const ciphertextBuffer = await crypto.subtle.encrypt(
//         {
//           name: 'RSA-OAEP',
//           hash: 'SHA-256',
//         },
//         rsaPublicKey,
//         contentBuffer
//       );

//       const ciphertextBase64 = btoa(String.fromCharCode(...new Uint8Array(ciphertextBuffer)));
//       console.log("Encrypted (base64):", ciphertextBase64);

//       console.log('Encrypted data:', {
//         ciphertext: ciphertextBase64,
//         error: ''
//       });

//       return ciphertextBase64

//       // sendToServer();
//     } catch (error: any) {
//       console.log({ ciphertext: '', error: `Encryption failed: ${error}` });
//       return ""
//     } finally {
//       return "";
//     }
// };

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

        let bodyRaw = JSON.stringify({
            accessToken: accessToken,
            event: event,
        })

        // console.log('Raw body to encrypt:', bodyRaw);
        
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
        .then(data => {
          if (data.error) {
            throw(data.error);
          }

          return JSON.parse(data.signed_event.signed_event);
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
