import { describe, expect, it } from 'vitest'
import { canonicalSpyCaptureUrl, SpyCaptureError } from './capture-url'

describe('canonical capture links', () => {
  it.each([
    ['https://api.whatsapp.com/send/?phone=5511999900011&text=oi&token=SANITIZED_TOKEN&fbclid=TRACK', 'https://wa.me/5511999900011'],
    ['https://wa.me/5511999900011?text=hello&utm_source=fixture', 'https://wa.me/5511999900011'],
    ['https://m.facebook.com/ads/library/?id=1234&token=SANITIZED_TOKEN', 'https://www.facebook.com/ads/library/?id=1234'],
    ['https://www.facebook.com/permalink.php?story_fbid=123&id=456&token=SANITIZED_TOKEN', 'https://www.facebook.com/permalink.php?id=456&story_fbid=123'],
    ['https://www.facebook.com/ads/library/?q=soap&country=MX&token=SANITIZED_TOKEN', 'https://www.facebook.com/ads/library?country=MX&q=soap'],
  ])('normalizes public identity without credentials/tracking: %s', (input, expected) => expect(canonicalSpyCaptureUrl(input)).toBe(expected))

  it.each(['', 'not a url', 'javascript:alert(1)', 'https://evil.test/?next=https://wa.me/5511999900011',
    'https://wa.me.evil.test/5511999900011', 'https://facebook.com.evil.test/posts/1', 'https://user:SANITIZED_TOKEN@facebook.com/page/posts/1',
    'https://facebook.com:8443/page/posts/1', 'https://wa.me/message/opaque', 'https://wa.me/123',
    'https://api.whatsapp.com/send?phone=5511999900011&phone=5511999900022', 'https://facebook.com/ads/library/',
  ])('rejects unsupported/ambiguous links without echoing input: %s', input => {
    expect(() => canonicalSpyCaptureUrl(input)).toThrow(SpyCaptureError)
    try { canonicalSpyCaptureUrl(input) } catch (err) { expect(String(err)).not.toContain('SANITIZED_TOKEN') }
  })
})
