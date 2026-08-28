import assert from 'node:assert/strict'
import { test } from 'node:test'
import { desEcbEncrypt, vncAuthResponse } from '../src/vncdes.mjs'
const hex = (value: string) => Buffer.from(value, 'hex')

test('vendored VNC DES matches classic FIPS vector', () => {
  assert.equal(desEcbEncrypt(hex('133457799BBCDFF1'), hex('0123456789ABCDEF')).toString('hex').toUpperCase(), '85E813540F0AB405')
})

test('VNC auth truncates password to eight bytes and encrypts 16-byte challenge', () => {
  const challenge = hex('00112233445566778899AABBCCDDEEFF')
  assert.equal(vncAuthResponse('abcdefgh', challenge).length, 16)
  assert.deepEqual(vncAuthResponse('abcdefgh', challenge), vncAuthResponse('abcdefghIGNORED', challenge))
  assert.throws(() => vncAuthResponse('x', Buffer.alloc(8)), /16 bytes/)
})
