import { randomEthereumAddress } from '@streamr/test-utils'
import { ContentType, EncryptionType, SignatureType } from '@streamr/trackerless-network'
import { toEthereumAddress, toStreamID, toUserId, utf8ToBinary } from '@streamr/utils'
import { Wallet } from 'ethers'
import { container } from 'tsyringe'
import { EthereumKeyPairIdentity } from '../../src/identity/EthereumKeyPairIdentity'
import { MessageID } from '../../src/protocol/MessageID'
import { StreamMessage, StreamMessageType } from '../../src/protocol/StreamMessage'
import { MessageSigner } from '../../src/signature/MessageSigner'
import { StreamrClient } from '../../src/StreamrClient'

const STREAM_ID = toStreamID('0x1234567890123456789012345678901234567890/foo')

describe('StreamrClient.getMessageSigner', () => {

    const wallet = Wallet.createRandom()
    const identity = EthereumKeyPairIdentity.fromPrivateKey(wallet.privateKey)
    const client = new StreamrClient({ environment: 'dev2' }, container)

    const createSignedMessage = async (publisherId: string, signatureType: SignatureType): Promise<StreamMessage> => {
        return new MessageSigner(identity).createSignedMessage({
            messageId: new MessageID(STREAM_ID, 0, Date.now(), 0, toUserId(publisherId), 'msgChainId'),
            content: utf8ToBinary(JSON.stringify({ hello: 'world' })),
            messageType: StreamMessageType.MESSAGE,
            contentType: ContentType.JSON,
            encryptionType: EncryptionType.NONE
        }, signatureType)
    }

    it('recovers the account behind an ERC-1271 signature, not the contract', async () => {
        const contractAddress = randomEthereumAddress()
        const msg = await createSignedMessage(contractAddress, SignatureType.ERC_1271)
        expect(msg.getPublisherId()).toBe(toUserId(contractAddress))
        expect(client.getMessageSigner(msg)).toBe(toEthereumAddress(wallet.address))
    })

    it('recovers the publisher of an ECDSA signature', async () => {
        const msg = await createSignedMessage(wallet.address, SignatureType.ECDSA_SECP256K1_EVM)
        expect(client.getMessageSigner(msg)).toBe(toEthereumAddress(wallet.address))
    })

    it('recovers someone else when the signature does not belong to the publisher', async () => {
        const msg = await createSignedMessage(randomEthereumAddress(), SignatureType.ECDSA_SECP256K1_EVM)
        expect(client.getMessageSigner(msg)).toBe(toEthereumAddress(wallet.address))
        expect(client.getMessageSigner(msg)).not.toBe(msg.getPublisherId())
    })
})
