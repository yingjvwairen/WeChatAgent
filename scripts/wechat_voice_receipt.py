"""Whitelist voice receipt metadata. Never return voice XML or media credentials."""
import re
import xml.etree.ElementTree as ET

MAX_BYTES = 65536


def voice_receipt_metadata(raw):
    try:
        if isinstance(raw, str):
            text = raw
            if len(text.encode('utf-8')) > MAX_BYTES:
                return None
        elif isinstance(raw, (bytes, bytearray, memoryview)):
            data = bytes(raw)
            if not data or len(data) > MAX_BYTES:
                return None
            if data.startswith(b'\x28\xb5\x2f\xfd'):
                import zstandard
                if zstandard.frame_content_size(data) > MAX_BYTES:
                    return None
                data = zstandard.ZstdDecompressor().decompress(data, max_output_size=MAX_BYTES, allow_extra_data=False)
            if len(data) > MAX_BYTES:
                return None
            text = data.decode('utf-8', errors='strict')
        else:
            return None
        if '<!DOCTYPE' in text.upper() or '<!ENTITY' in text.upper():
            return None
        root = ET.fromstring(text)
        children = list(root)
        if root.tag != 'msg' or len(children) != 1 or children[0].tag != 'voicemsg' or len(list(children[0])):
            return None
        voice = children[0]
        if (root.text or '').strip() or (voice.text or '').strip() or (voice.tail or '').strip():
            return None
        duration = voice.attrib.get('voicelength', '')
        if not re.fullmatch(r'[1-9][0-9]{0,5}', duration) or int(duration) > 300000:
            return None
        # endflag is not completion proof: received/played historical fixtures
        # use 0. Only reject explicit cancellation; a server ID gates receipts.
        if voice.attrib.get('cancelflag', '0') != '0':
            return None
        return {'version': 1, 'durationMs': int(duration)}
    except Exception:
        return None
