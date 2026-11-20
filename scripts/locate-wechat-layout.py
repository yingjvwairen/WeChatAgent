"""Read-only layout candidates for the observed WeChat 4.1.15.56 dark UI.

This module does not authorize a draft, identify a chat, capture a desktop or
send input. Native callers must independently bind/recapture the same process
and pixels, verify a completely empty editor, and verify the selected identity.
"""
from __future__ import annotations
import argparse
import base64
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import sys
import time

ROOT = Path(__file__).resolve().parent.parent
VERSION = '4.1.15.56'
TEMPLATES = Path(__file__).with_name('wechat-layout-templates.json')
NAVIGATION_TEMPLATES = Path(__file__).with_name('wechat-navigation-templates.json')
NAVIGATION_TEMPLATE_SHA256 = '7f10b2c4d70489b61d2fa1a94cc98f40e3181c77e3f3c4c4894987a83682c005'
# Public pinned-message indicator only; antialiased gold-ink shape at 144 DPI.
# Contains no title, avatar, chat text or account-dependent pixels.
PINNED_MESSAGE_INK = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADOcDQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWXsAAAAeOAAAAAAAAAAAAAAAAAAAAAAAAAB3HAAAB4iYAgAAAAAAAAAAAAAAAAofFwIAADsAAABllDUAAAAAAAAAAAAAOHeTnJycmodfEwAAO24OAAAAAAAAAAAAE3ucm3RPTk5WjJyaSQAcAAAAAAAAAAAAABSRm1UQAAAAAAAALX6cWgAAAAJGcwkAAAAEg5MmAAAAAAAAAAAAA2ScOwAnhZJvBQAAAFScLAAAAAAAAAAAAAAAAHyVCxcPAAAAAAACkn4AAAAAAAAAAAAAAAAANpxCAAAAAAAAABmcWAAAAAAAAAAAAAAAAAANnGoAAAAAAAAAIpxQAAAAAAAAAAAAAAAAAACbfQAAAAAAAAAUnGMAAAAAAAAAAAAAAAAACZxtAAAAAAAAAAKSkAIAAAAAAAAAAAAAAAAxnEYAAAAAAAAAAFqcVAAAAAAAAAAAAAAAAHmXDQAAAAAAAAAACY2cSwAAAAAAAAAAAANknFAAAAAAAAAAAAAAHpSaAAAAAAAAAAEwg5xkAgAAAAAAAAAAAAAATI0AEUtOTk5ZjZyZRQAAAAAAAAAAAAAAAABaiV+ZnJycnJqGXxMAAAAAAAAAAAAAAAAAAFGcbzIIIiYXAgAAAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
# Native 200% glyph rasterization differs from resizing the 150% sample.
PINNED_MESSAGE_INK_192 = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACEYPAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABRnE0AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHGaFQAAAAANEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAjVsAAAAAKJeWBgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAmTCQAAAA2NnIkBAAAAAAAAAAAAAAAAAAAAAAANHh8PAAAADi4AAAAAcpx4EwAAAAAAAAAAAAAAAAAADU91lZycnJyXeFEQAAAAAEaVQQAAAAAAAAAAAAAAAAAABVWXnJycnJycnJycnJpbCAAAahMAAAAAAAAAAAAAAAAAAB+HnJx0RS4cCQUaLEJsnJyKJAAAAAAAAAAAAAAAAAAAAAAklZyDHgAAAAAAAAAAAAAZfZyXKQAAAAAETpdfAAAAAAAAFJWcbgMAAAAAAAAAAAAAAAACX5yWGAAANoqcnG4AAAAAAAB2nH0FAAAAAAAAAAAAAAAAAAAAapx6ABdsTC0QAAAAAAAAJ5yYFwAAAAAAAAAAAAAAAAAAAAAUmpwrAAAAAAAAAAAAAABgnG4AAAAAAAAAAAAAAAAAAAAAAABznGIAAAAAAAAAAAAAAIOcRAAAAAAAAAAAAAAAAAAAAAAAAEaciQAAAAAAAAAAAAAAlJw4AAAAAAAAAAAAAAAAAAAAAAAAM5ycAwAAAAAAAAAAAACTnD8AAAAAAAAAAAAAAAAAAAAAAAAwnJwDAAAAAAAAAAAAAIGcUwAAAAAAAAAAAAAAAAAAAAAAAEKcjgAAAAAAAAAAAAAAZZyJAAAAAAAAAAAAAAAAAAAAAAAAbpxoAAAAAAAAAAAAAAAsnJw9AAAAAAAAAAAAAAAAAAAAABeZnC8AAAAAAAAAAAAAAAF/nJUXAAAAAAAAAAAAAAAAAAAEfJx6AQAAAAAAAAAAAAAAABqYnJAiAAAAAAAAAAAAAAAAAmqclxkAAAAAAAAAAAAAAAAAADGZnGoAAAAAAAAAAAAAAByAnJw2AAAAAAAAAAAAAAAAAAAAADucWwAAAAAAAAAADjhunJyaQgAAAAAAAAAAAAAAAAAAAAAAN5xNBkKJnJycnJycnJycfx4AAAAAAAAAAAAAAAAAAAAAAABKnHyUnJycnJycnJyLVB4AAAAAAAAAAAAAAAAAAAAAAAAAAEacnJVWEhIpQUY2HgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAj1ACAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=='


def need(value, code):
    if not value:
        raise ValueError('LAYOUT_' + code)


def rect(left, top, right, bottom):
    return dict(left=int(left), top=int(top), right=int(right), bottom=int(bottom))


def contains(outer, inner):
    return (outer['left'] <= inner['left'] < inner['right'] <= outer['right'] and
            outer['top'] <= inner['top'] < inner['bottom'] <= outer['bottom'])


def label_in_control(control, label):
    # OCR boxes include estimated ascender/descender padding. Their horizontal
    # extent and centre must be inside; at least 85% of their area must overlap.
    overlap=max(0,min(control['bottom'],label['bottom'])-max(control['top'],label['top']))
    return (control['left'] <= label['left'] < label['right'] <= control['right'] and
            control['top'] < (label['top']+label['bottom'])/2 < control['bottom'] and
            overlap/(label['bottom']-label['top']) >= .85)


def groups(values):
    result = []
    for value in values:
        if result and value <= result[-1][-1] + 2:
            result[-1].append(int(value))
        else:
            result.append([int(value)])
    return result


def neutral_navigation_boundary(pixels,top,bottom,scale,*,allow_missing=False):
    """A dark RGB step can lose one level when converted to grayscale."""
    import numpy as np
    band=pixels[top:bottom].astype(np.int16);left,right=band[:,:-1],band[:,1:];delta=right-left
    edge=np.max(np.abs(delta),axis=2)>=4
    neutral=(edge&((np.min(delta,axis=2)>=3)|(np.max(delta,axis=2)<=-3))
             &(np.max(left,axis=2)-np.min(left,axis=2)<=3)&(np.max(right,axis=2)-np.min(right,axis=2)<=3)
             &(np.max(left,axis=2)<70)&(np.max(right,axis=2)<70))
    support=edge.mean(axis=0);neutral_support=neutral.mean(axis=0)
    found=groups([x+1 for x in range(len(support)) if 45*scale<=x+1<=110*scale and support[x]>=.95 and neutral_support[x]>.78])
    if not found and allow_missing:return None,None
    need(len(found)==1 and len(found[0])==1,'NAVIGATION_BOUNDARY_UNCERTAIN')
    x=found[0][0]
    return x,{'kind':'long-navigation-divider','support':round(float(support[x-1]),6),
              'method':'neutral-rgb-step','neutralSupport':round(float(neutral_support[x-1]),6)}


def template_set():
    import numpy as np
    value = json.loads(TEMPLATES.read_text(encoding='utf8'))
    need(value.get('version') == 1 and value.get('executableVersion') == VERSION, 'TEMPLATE_INVALID')
    result = []
    for item in value['templates']:
        need(item['kind'] in ('recordStart', 'cancel', 'submit') and item['dpi'] in (96, 120, 144, 192), 'TEMPLATE_INVALID')
        width, height = item['width'], item['height']
        need(type(width) is int and type(height) is int and 8 <= width <= 100 and 8 <= height <= 100, 'TEMPLATE_INVALID')
        raw = base64.b64decode(item['pixels'], validate=True)
        need(len(raw) == width * height and hashlib.sha256(raw).hexdigest() == item['sha256'], 'TEMPLATE_INVALID')
        result.append((item['kind'], item['dpi'], np.frombuffer(raw, np.uint8).reshape(height, width)))
    return result


def navigation_template_set():
    # Native rasterization at 125% differs from resampling the 100% glyphs.
    # Both pinned banks participate in the same global uniqueness check; a
    # second match from either bank must still reject the navigation candidate.
    import numpy as np
    raw=NAVIGATION_TEMPLATES.read_bytes()
    need(hashlib.sha256(raw).hexdigest()==NAVIGATION_TEMPLATE_SHA256,'NAVIGATION_TEMPLATE_INVALID')
    value=json.loads(raw);need(value.get('version')==2 and value.get('executableVersion')==VERSION,'NAVIGATION_TEMPLATE_INVALID')
    expected=[(kind,dpi) for dpi in (96,120) for kind in ('contacts','box','compass')]
    need([(item.get('kind'),item.get('dpi')) for item in value.get('templates',[])]==expected,'NAVIGATION_TEMPLATE_INVALID')
    result=[]
    for item in value['templates']:
        width,height=item['width'],item['height'];need(type(width) is int and type(height) is int and 16<=width<=40 and 16<=height<=40,'NAVIGATION_TEMPLATE_INVALID')
        data=base64.b64decode(item['pixels'],validate=True)
        need(len(data)==width*height and hashlib.sha256(data).hexdigest()==item['sha256'],'NAVIGATION_TEMPLATE_INVALID')
        result.append((item['kind'],item['dpi'],np.frombuffer(data,np.uint8).reshape(height,width)))
    return result


def navigation_glyphs(gray,dpi):
    import numpy as np
    height,width=gray.shape;s=dpi/120;scale=dpi/96
    area=rect(0,round(130*s),min(width,round(110*s)),min(height,round(360*s)))
    samples=navigation_template_set();glyphs=[]
    for role in ('contacts','box','compass'):
        found,score=match_control(gray,area,dpi,role,samples,minimum=.93,uniqueness=.10)
        glyphs.append({'kind':role,'rect':found,'score':score})
    centers=[((g['rect']['left']+g['rect']['right'])/2,(g['rect']['top']+g['rect']['bottom'])/2) for g in glyphs]
    need(max(x for x,_ in centers)-min(x for x,_ in centers)<=1.5*scale
         and all(abs(centers[i+1][1]-centers[i][1]-48*scale)<=3*scale for i in range(2)),'NAVIGATION_GLYPHS_UNCERTAIN')
    nav_x=round(2*float(np.median([x for x,_ in centers])))
    need(45*s<=nav_x<=110*s,'NAVIGATION_GLYPHS_UNCERTAIN')
    return nav_x,{'kind':'long-navigation-divider','method':'known-glyph-constellation','templateSha256':NAVIGATION_TEMPLATE_SHA256,'glyphs':glyphs}


def match_control(gray, region, dpi, kind, templates, *, minimum=.89, uniqueness=.07):
    import cv2
    import numpy as np
    area = gray[region['top']:region['bottom'], region['left']:region['right']]
    matches = []
    for role, sample_dpi, sample in templates:
        if role != kind:
            continue
        for delta in (.97, 1.0, 1.03):
            scale = dpi / sample_dpi * delta
            size = (round(sample.shape[1] * scale), round(sample.shape[0] * scale))
            if min(size) < 8 or size[0] > area.shape[1] or size[1] > area.shape[0]:
                continue
            template = cv2.resize(sample, size, interpolation=cv2.INTER_AREA if scale < 1 else cv2.INTER_LINEAR)
            scores = cv2.matchTemplate(area, template, cv2.TM_CCOEFF_NORMED)
            for _ in range(2):
                _, score, _, point = cv2.minMaxLoc(scores)
                if not np.isfinite(score):
                    break
                x, y = point
                matches.append((float(score), rect(region['left']+x, region['top']+y, region['left']+x+size[0], region['top']+y+size[1])))
                scores[max(0,y-size[1]):y+size[1], max(0,x-size[0]):x+size[0]] = -1
    need(matches, 'CONTROL_TEMPLATE_MISSING')
    matches.sort(key=lambda item: -item[0]); score, found = matches[0]
    need(score >= minimum, 'CONTROL_UNCERTAIN')
    cx, cy = (found['left']+found['right'])/2, (found['top']+found['bottom'])/2
    others = [v for v, r in matches[1:] if abs((r['left']+r['right'])/2-cx) > (found['right']-found['left'])*.8 or abs((r['top']+r['bottom'])/2-cy) > (found['bottom']-found['top'])*.8]
    need(not others or score-max(others) >= uniqueness, 'CONTROL_AMBIGUOUS')
    return found, round(score, 6)


def pinned_message_header(pixels, separators, chat_x, chrome_y, dpi):
    """A second header row needs its public indicator, not just a lower line.

    The title/interaction header ends above the indicator. Pinned content is
    never included in the title OCR or the header pixels used for sending.
    """
    import numpy as np
    s=dpi/120
    boundaries=[v for v in separators if 125*s < v[0] <= 180*s]
    need(len(boundaries)==1,'HEADER_BOUNDARY_UNCERTAIN')
    separator=boundaries[0][-1]
    region=rect(chat_x+round(12*s),chrome_y+round(60*s),chat_x+round(55*s),separator-round(12*s))
    need(region['bottom']>region['top'] and region['right']<pixels.shape[1],'HEADER_BOUNDARY_UNCERTAIN')
    b,g,r=(pixels[:,:,i].astype(np.int16) for i in range(3))
    gold=np.clip(np.minimum(r,g)-b,0,255).astype(np.uint8)
    templates=[('pinned-message',source_dpi,np.frombuffer(base64.b64decode(ink),np.uint8).reshape(h,w))
               for source_dpi,w,h,ink in [(144,26,24,PINNED_MESSAGE_INK),(192,35,32,PINNED_MESSAGE_INK_192)]]
    try:icon,score=match_control(gold,region,dpi,'pinned-message',templates,minimum=.94)
    except ValueError:raise ValueError('LAYOUT_HEADER_BOUNDARY_UNCERTAIN') from None
    need(14*s <= separator-icon['bottom'] <= 35*s,'HEADER_BOUNDARY_UNCERTAIN')
    title_bottom=icon['top']-math.ceil(8*s)
    need(70*s <= title_bottom <= 125*s,'HEADER_BOUNDARY_UNCERTAIN')
    return title_bottom,{'method':'pinned-message-glyph-and-divider-v1','iconRect':icon,
                        'score':score,'separatorY':separator,'titleRowBottom':title_bottom}


def blank_caption_region(gray, chat_x, chrome_y, dpi):
    """Choose an observed flat patch inside chrome, clear of system controls.

    The titlebar may show a changing backdrop gradient. A fixed x-offset can
    land on that gradient although a stable blank patch exists nearby. This
    selects the lowest-contrast measured patch (including its surroundings);
    it never relaxes the blank threshold or later exact native pixel checks.
    """
    import numpy as np
    s=dpi/120;width=gray.shape[1];top,bottom=round(7*s),round(19*s)
    left,right=chat_x+round(20*s),width-round(220*s)
    patch_width=round(40*s);margin=max(2,round(4*s))
    need(right-left>=patch_width and top>=margin and bottom+margin<chrome_y,'FOCUS_AREA_UNCERTAIN')
    candidates=[];center=(left+right)/2
    for x in range(left,right-patch_width+1):
        surrounding=gray[top-margin:bottom+margin,x-margin:x+patch_width+margin]
        spread=int(surrounding.max())-int(surrounding.min())
        if spread<=3:
            patch=gray[top:bottom,x:x+patch_width]
            candidates.append(((spread,float(np.var(surrounding)),float(np.var(patch)),abs(x+patch_width/2-center)),x))
    need(candidates,'FOCUS_AREA_NOT_BLANK')
    _,x=min(candidates)
    return rect(x,top,x+patch_width,bottom)


def rectangle_candidates(gray, region, min_width, max_width, min_height, max_height):
    import cv2
    # Fixed low-threshold edges include the actual editor/button outlines.
    # Candidate geometry alone is never sufficient: labels/icons are checked.
    crop=gray[region['top']:region['bottom'],region['left']:region['right']]
    import numpy as np
    edges=cv2.morphologyEx(cv2.Canny(crop, 10, 30),cv2.MORPH_CLOSE,np.ones((3,3),np.uint8))
    contours,_=cv2.findContours(edges,cv2.RETR_LIST,cv2.CHAIN_APPROX_SIMPLE)
    result=[]
    for contour in contours:
        x,y,w,h=cv2.boundingRect(contour)
        if min_width <= w <= max_width and min_height <= h <= max_height:
            perimeter=cv2.arcLength(contour,True)
            if perimeter >= (w+h)*1.75:
                area=abs(cv2.contourArea(contour))
                if area >= w*h*.8:
                    result.append(rect(region['left']+x,region['top']+y,region['left']+x+w,region['top']+y+h))
    # Canny gives inner/outer edges. Collapse only almost-identical rectangles.
    unique=[]
    for item in sorted(result,key=lambda r:-(r['right']-r['left'])*(r['bottom']-r['top'])):
        tolerance=max(4,min(8,round(min(item['right']-item['left'],item['bottom']-item['top'])*.025)))
        if not any(max(abs(item[k]-other[k]) for k in item) <= tolerance for other in unique):
            unique.append(item)
    return unique


def editor_frame_candidates(pixels,gray,region,scale):
    """Recover a complete frame when external chat content joins its contour."""
    import numpy as np
    width,height=pixels.shape[1],pixels.shape[0];chat=region['left']
    def candidates(image):
        found=rectangle_candidates(image,region,(width-chat)*.85,width-chat,105*scale,290*scale)
        return [r for r in found if 4*scale<=r['left']-chat<=22*scale and 5*scale<=width-r['right']<=25*scale and 5*scale<=height-r['bottom']<=25*scale]
    original=candidates(gray)
    if len(original)==1:return original
    # Keep an independently complete, original inner contour. Bright/colored
    # history touching the outside can enlarge only its outer counterpart.
    recovered=[]
    for inner in original:
        center=gray[(inner['top']+inner['bottom'])//2,(inner['left']+inner['right'])//2]
        background=int(center)
        if not 15<=background<=65:continue
        neutral=pixels.max(axis=2).astype(np.int16)-pixels.min(axis=2).astype(np.int16)<=3
        strokes=neutral&(gray.astype(np.int16)>=background+4)&(gray.astype(np.int16)<=background+40)
        outline=np.where(strokes,gray,background).astype(np.uint8)
        for outer in candidates(outline):
            gaps=[inner['left']-outer['left'],inner['top']-outer['top'],outer['right']-inner['right'],outer['bottom']-inner['bottom']]
            if all(1<=gap<=math.ceil(4*scale) for gap in gaps) and outer not in recovered:recovered.append(outer)
    return recovered


def anchor_lines(result, region):
    lines={}
    for word in result.get('words',[]):
        try:
            area=rect(word['x'],word['y'],word['x']+word['width']+.999,word['y']+word['height']+.999)
            if contains(region,area):
                lines.setdefault(word['line'],[]).append((word,area))
        except (KeyError,TypeError,ValueError):
            continue
    for words in lines.values():
        words.sort(key=lambda item:item[1]['left'])
    return list(lines.values())


def anchor_words(result, label, region):
    found=[]
    for words in anchor_lines(result,region):
        if ''.join(word['text'] for word,_ in words) == label and min(word['confidence'] for word,_ in words) >= .97:
            found.append((rect(min(r['left'] for _,r in words),min(r['top'] for _,r in words),max(r['right'] for _,r in words),max(r['bottom'] for _,r in words)),min(word['confidence'] for word,_ in words)))
    need(len(found)==1, 'OCR_ANCHOR_UNCERTAIN')
    return found[0]


def scaled_control_pixels(pixels,digest,region,recognize):
    """One fixed pixel transform; preserve raw OCR scores and source geometry."""
    import cv2
    height,width=pixels.shape[:2]
    need(contains(rect(0,0,width,height),region),'OCR_BINDING_INVALID')
    crop=pixels[region['top']:region['bottom'],region['left']:region['right']]
    resized=cv2.resize(crop,None,fx=1.25,fy=1.25,interpolation=cv2.INTER_CUBIC)
    result=recognize(resized)
    need(result.get('imageSha256')==digest and result.get('width')==resized.shape[1] and result.get('height')==resized.shape[0],'OCR_BINDING_INVALID')
    scale_x=scale_y=1.25
    words=[{**word,'x':region['left']+word['x']/scale_x,'y':region['top']+word['y']/scale_y,
            'width':word['width']/scale_x,'height':word['height']/scale_y} for word in result.get('words',[])]
    return {**result,'width':width,'height':height,'words':words,'region':dict(region),'layoutPreprocess':'control-cubic-1.25'}


def padded_control_pixels(pixels,digest,region,recognize):
    """Fixed 96-DPI search context; no new source pixels or altered scores."""
    import cv2
    height,width=pixels.shape[:2]
    need(contains(rect(0,0,width,height),region),'OCR_BINDING_INVALID')
    crop=pixels[region['top']:region['bottom'],region['left']:region['right']]
    framed=cv2.copyMakeBorder(crop,16,16,0,0,cv2.BORDER_REPLICATE)
    result=recognize(framed)
    need(result.get('imageSha256')==digest and result.get('width')==framed.shape[1]
         and result.get('height')==framed.shape[0],'OCR_BINDING_INVALID')
    words=[{**word,'x':region['left']+word['x'],'y':region['top']+word['y']-16}
           for word in result.get('words',[])]
    # Virtual padding is context only; a glyph detected there is not evidence.
    need(all(contains(region,rect(w['x'],w['y'],w['x']+w['width']+.999,w['y']+w['height']+.999))
             for w in words),'OCR_BINDING_INVALID')
    return {**result,'width':width,'height':height,'words':words,'region':dict(region),'layoutPreprocess':'control-border-16'}


def search_anchor(result,region,control,recognize_scaled,source_region):
    try:
        found,score=anchor_words(result,'搜索',region)
        return found,score,False
    except ValueError as error:
        # Only an already complete, unique, correctly placed fixed UI label
        # can retry for confidence. Wrong/unknown text never selects a scale.
        need(str(error)=='LAYOUT_OCR_ANCHOR_UNCERTAIN' and callable(recognize_scaled),'OCR_ANCHOR_UNCERTAIN')
        lines=anchor_lines(result,region)
        need(len(lines)==1 and ''.join(w['text'] for w,_ in lines[0])=='搜索','OCR_ANCHOR_UNCERTAIN')
        words=lines[0]
        label=rect(min(r['left'] for _,r in words),min(r['top'] for _,r in words),max(r['right'] for _,r in words),max(r['bottom'] for _,r in words))
        need(all(isinstance(w.get('confidence'),(int,float)) and 0<=w['confidence']<=1 for w,_ in words)
             and min(w['confidence'] for w,_ in words)<.97 and label_in_control(control,label),'OCR_ANCHOR_UNCERTAIN')
        refined=recognize_scaled()
        need(all(refined.get(key)==result.get(key) for key in ['imageSha256','width','height'])
             and refined.get('region')==source_region and refined.get('layoutPreprocess')=='control-cubic-1.25','OCR_BINDING_INVALID')
        refined_lines=anchor_lines(refined,region)
        need(len(refined_lines)==1 and ''.join(w['text'] for w,_ in refined_lines[0])=='搜索','OCR_ANCHOR_UNCERTAIN')
        found,score=anchor_words(refined,'搜索',region)
        need(label_in_control(control,found),'OCR_ANCHOR_UNCERTAIN')
        return found,score,True


def title_structure(result, area):
    words=result.get('words',[])
    need(words and 1<=sum(len(w.get('text','')) for w in words)<=64,'CHAT_TITLE_UNCERTAIN')
    rectangles=[rect(w['x'],w['y'],w['x']+w['width']+.999,w['y']+w['height']+.999) for w in words]
    need(all(contains(area,r) for r in rectangles) and all(isinstance(w.get('confidence'),(int,float)) and 0<=w['confidence']<=1 for w in words),'CHAT_TITLE_UNCERTAIN')
    if len({w.get('line') for w in words})>1:
        # A group member count may be a separate OCR detection on the same
        # physical text row. Do not treat OCR line IDs as screen row geometry.
        # Adjacent detections can repeat their shared boundary parenthesis;
        # only identical, strongly overlapping characters may be deduplicated.
        heights=[r['bottom']-r['top'] for r in rectangles]
        common=min(r['bottom'] for r in rectangles)-max(r['top'] for r in rectangles)
        centers=[(r['top']+r['bottom'])/2 for r in rectangles]
        need(common>=min(heights)*.65 and max(centers)-min(centers)<=max(heights)*.3,'CHAT_TITLE_UNCERTAIN')
        retained=[];duplicates=0
        for word,r in sorted(zip(words,rectangles),key=lambda pair:-pair[0]['confidence']):
            duplicate=False
            for other,q in retained:
                if word.get('line')==other.get('line'):continue
                intersection=max(0,min(r['right'],q['right'])-max(r['left'],q['left']))*max(0,min(r['bottom'],q['bottom'])-max(r['top'],q['top']))
                overlap=intersection/min((r['right']-r['left'])*(r['bottom']-r['top']),(q['right']-q['left'])*(q['bottom']-q['top']))
                if overlap>.25:
                    need(overlap>=.6 and len(word['text'])==1 and word['text']==other['text'],'CHAT_TITLE_UNCERTAIN');duplicate=True;duplicates+=1;break
            if not duplicate:retained.append((word,r))
        need(duplicates<=1 and {w.get('line') for w,_ in retained}=={w.get('line') for w in words},'CHAT_TITLE_UNCERTAIN')
        words=[w for w,_ in retained];rectangles=[r for _,r in retained]
    return rect(min(r['left'] for r in rectangles),min(r['top'] for r in rectangles),max(r['right'] for r in rectangles),max(r['bottom'] for r in rectangles)),min(w['confidence'] for w in words),''.join(w['text'] for w in sorted(words,key=lambda w:w['x']))


def title_anchor(result, area, recognize_scaled=None):
    found,score,text=title_structure(result,area)
    if score>=.97:return found,score
    need(callable(recognize_scaled),'CHAT_TITLE_UNCERTAIN')
    refined=recognize_scaled()
    need(all(refined.get(key)==result.get(key) for key in ['imageSha256','width','height']) and refined.get('region')==area
         and refined.get('layoutPreprocess')=='control-cubic-1.25','OCR_BINDING_INVALID')
    retry,retry_score,retry_text=title_structure(refined,area)
    # This is a navigation label, never a contact-identity proof. Even here a
    # different or partial string cannot replace the original whole line.
    need(retry_score>=.97 and retry_text==text,'CHAT_TITLE_UNCERTAIN')
    return retry,retry_score


def rgba_hash(pixels, area):
    import cv2
    return hashlib.sha256(cv2.cvtColor(pixels[area['top']:area['bottom'],area['left']:area['right']],cv2.COLOR_BGR2RGBA).tobytes()).hexdigest()


def editor_inner_edges(gray,frame,toolbar,dpi):
    """Measure the inner sides of the already found frame, not blank content."""
    import numpy as np
    need(dpi==96,'EDITOR_INNER_EDGE_UNCERTAIN');s=dpi/120
    image=gray.astype(np.int16)
    rows=slice(frame['top']+math.ceil(12*s),toolbar['top']-math.ceil(4*s))
    columns=slice(frame['left']+math.ceil(12*s),frame['right']-math.ceil(12*s))
    need(rows.stop-rows.start>=40 and columns.stop-columns.start>=100,'EDITOR_INNER_EDGE_UNCERTAIN')
    result={'version':1,'method':'signed-frame-gradient-96'}
    for side in ('left','top','right'):
        positions=range(frame[side]+math.floor(2*s),frame[side]+math.ceil(4*s)+1) if side!='right' else range(frame[side]-math.ceil(4*s),frame[side]-math.floor(2*s)+1)
        support={}
        for position in positions:
            delta=image[position-1,columns]-image[position,columns] if side=='top' else image[rows,position-1]-image[rows,position] if side=='left' else image[rows,position]-image[rows,position-1]
            value=float((delta>=4).mean())
            if value>=.95:support[position]=value
        found=sorted(support)
        # At most a two-pixel antialias ramp; disconnected/second boundaries
        # are ambiguous. Choose the edge nearest the complete content area.
        need(found and len(found)<=2 and found==list(range(found[0],found[-1]+1)),'EDITOR_INNER_EDGE_UNCERTAIN')
        position=found[0] if side=='right' else found[-1]
        result[side]={'position':position,'support':round(support[position],6)}
    return result


def contact_panel_separators(pixels,dpi,chat_x,header_bottom,right):
    """Observe three complete panel-owned rules, never infer its invisible edge.

    The dark panel can share its background with the chat. Its horizontal
    rules still have independently visible endpoints. A controls-bounded
    observation region begins at those endpoints; it is not the panel border.
    """
    import numpy as np
    height,width=pixels.shape[:2];s=dpi/120;image=pixels.astype(np.int16);found=[]
    for y in range(header_bottom+round(40*s),min(height-3,header_bottom+round(350*s))):
        row,above=image[y],image[y-1];delta=row-above
        mask=(np.min(delta,axis=1)>=4)&(np.max(row,axis=1)<70)&(np.ptp(row,axis=1)<=3)
        ids=np.flatnonzero(mask)
        for run in np.split(ids,np.flatnonzero(np.diff(ids)>1)+1):
            if not len(run):continue
            left,end=int(run[0]),int(run[-1])+1
            if not (180*s<=end-left<=380*s and max(chat_x+60*s,width-400*s)<=left<=width-200*s and 10*s<=right-end<=30*s):continue
            color=image[y,left];background=image[y-1,left];bottom=y+1
            while bottom<min(height,y+int(np.ceil(2*s))+1) and np.all(image[bottom,left:end]==color):bottom+=1
            if (bottom-y>int(np.ceil(2*s)) or not np.all(image[y:bottom,left:end]==color)
                    or not np.all(image[y-1,left:end]==background) or not np.all(image[bottom,left:end]==background)
                    or not np.all(image[y:bottom,left-1]==background) or not np.all(image[y:bottom,end]==background)
                    or np.ptp(background)>3 or np.min(color-background)<4):continue
            found.append({'rect':rect(left,y,end,bottom),'support':1.0,'contrastMin':int(np.min(color-background))})
    constellations={}
    for item in found:
        r=item['rect'];constellations.setdefault((r['left'],r['right']),[]).append(item)
    candidates=[rows for rows in constellations.values() if len(rows)>=3]
    need(len(candidates)==1 and len(candidates[0])==3,'CONTACT_PANEL_BOUNDARY_UNCERTAIN')
    return candidates[0]


def locate_contact_panel(pixels,digest,dpi,version,recognize,chat_x,chrome_y,header_bottom,recognize_scaled=None):
    import cv2
    import numpy as np
    height,width=pixels.shape[:2];s=dpi/120;gray=cv2.cvtColor(pixels,cv2.COLOR_BGR2GRAY)
    band=gray[header_bottom+round(4*s):height-round(18*s)].astype(np.int16)
    support=(np.abs(np.diff(band,axis=1))>3).mean(axis=0)
    lines=groups(np.where(support>.97)[0]+1)
    lefts=[v for v in lines if max(chat_x+60*s,width-400*s)<=v[0]<=width-240*s]
    rights=[v for v in lines if width-15*s<=v[0]<=width-3*s]
    need(len(lefts)<=1 and len(rights)==1,'CONTACT_PANEL_BOUNDARY_UNCERTAIN')
    right=rights[0][0];rules=None
    if lefts:left=lefts[0][0]
    else:
        rules=contact_panel_separators(pixels,dpi,chat_x,header_bottom,right)
        left=rules[0]['rect']['left']
    span=gray[:,left+round(20*s):right-round(20*s)].astype(np.int16)
    horizontal=(np.abs(np.diff(span,axis=0))>3).mean(axis=1)
    bottoms=[v for v in groups(np.where(horizontal>.97)[0]+1) if height-20*s<=v[0]<=height-2*s]
    need(len(bottoms)==1,'CONTACT_PANEL_BOUNDARY_UNCERTAIN');panel=rect(left,header_bottom,right,bottoms[0][0])
    ocr_area=rect(left+round((-5 if rules else 12)*s),header_bottom+round(6*s),right-round(48*s),min(panel['bottom'],header_bottom+round(420*s)))
    result=recognize(ocr_area)
    need(result.get('imageSha256')==digest and result.get('width')==width and result.get('height')==height,'OCR_BINDING_INVALID')
    labels=[anchor_words(result,label,ocr_area) for label in ['添加','查找聊天内容','消息免打扰','置顶聊天','清空聊天记录']]
    need(all(labels[i][0]['bottom']<labels[i+1][0]['top'] for i in range(4)),'CONTACT_PANEL_CONTROL_ORDER_INVALID')
    add,lookup=labels[0][0],labels[1][0]
    if rules:
        first,second,third=[item['rect'] for item in rules];mute,pin,clear=[item[0] for item in labels[2:]]
        need(all(contains(panel,r) for r,_ in labels)
             and add['bottom']<first['top']<first['bottom']<lookup['top']<lookup['bottom']<second['top']
             and second['bottom']<mute['top']<mute['bottom']<pin['top']<pin['bottom']<third['top']<third['bottom']<clear['top']
             and all(abs(r['left']-left)<=4*s for r in [lookup,mute,pin])
             and abs((clear['left']+clear['right'])/2-(first['left']+first['right'])/2)<=8*s,'CONTACT_PANEL_CONTROL_ORDER_INVALID')
    upper=rect(left+round((0 if rules else 8)*s),header_bottom+round(5*s),right-round(8*s),lookup['top']-round(20*s))
    crop=pixels[upper['top']:upper['bottom'],upper['left']:upper['right']]
    background=np.median(crop.reshape(-1,3),axis=0)
    mask=(np.max(np.abs(crop.astype(float)-background),axis=2)>25).astype(np.uint8)*255
    _,_,stats,_=cv2.connectedComponentsWithStats(mask,8);avatars=[]
    for x,y,w,h,area in stats[1:]:
        if 33*s<=w<=60*s and 33*s<=h<=60*s and abs(w-h)<=3*s and area>=w*h*.8:
            avatars.append(rect(upper['left']+x,upper['top']+y,upper['left']+x+w,upper['top']+y+h))
    need(len(avatars)==1,'CONTACT_MEMBER_AMBIGUOUS');member=avatars[0]
    need(member['right']+5*s<add['left'] and member['bottom']<=add['top']<=member['bottom']+30*s,'CONTACT_MEMBER_ADD_RELATION_INVALID')
    title_area=rect(chat_x+round(10*s),chrome_y+round(4*s),min(width-round(150*s),chat_x+round(320*s)),header_bottom-round(4*s))
    title_ocr=recognize(title_area)
    need(title_ocr.get('imageSha256')==digest and title_ocr.get('width')==width and title_ocr.get('height')==height,'OCR_BINDING_INVALID')
    close,close_score=title_anchor(title_ocr,title_area,(lambda:recognize_scaled(title_area)) if callable(recognize_scaled) else None)
    boundary=({'kind':'contact-panel-boundary','method':'controls-bounded-region','rightSupport':round(float(support[right-1]),6),
               'bottomSupport':round(float(horizontal[panel['bottom']-1]),6),'separators':rules} if rules else
              {'kind':'contact-panel-boundary','support':round(float(support[left-1]),6)})
    controls={'kind':'contact-panel-controls','count':5,'confidence':round(min(score for _,score in labels),6)}
    if rules:controls['labels']=[{'role':role,'rect':r} for role,(r,_) in zip(['add','lookup','mute','pin','clear'],labels)]
    return {'version':1,'ok':True,'mode':'contact-panel','executableVersion':version,'imageSha256':digest,'width':width,'height':height,'dpi':dpi,
        'readOnly':True,'inputSent':False,'emptyDraftAuthorized':False,'identityVerified':False,
        'anchors':{'panel':panel,'profileMember':member,'profilePanelClose':close},'panelRgbaSha256':rgba_hash(pixels,panel),'memberRgbaSha256':rgba_hash(pixels,member),'closeRgbaSha256':rgba_hash(pixels,close),
        'evidence':[boundary,controls,{'kind':'member-avatar-component','rect':member},{'kind':'member-add-control','rect':add},{'kind':'header-title-toggle','rect':close,'confidence':round(close_score,6)}],
        'unknown':['completeContactIdentity','profilePopup']}


def locate(pixels, digest, dpi, version, recognize, *, recording_state=False, contact_panel=False, templates=None, recognize_scaled=None, recognize_padded=None):
    import cv2
    import numpy as np
    started=time.monotonic();height,width=pixels.shape[:2]
    need(version == VERSION, 'VERSION_UNSUPPORTED')
    need(type(dpi) is int and 96 <= dpi <= 240, 'DPI_UNSUPPORTED')
    # Match the native client's supported width. This only permits analysis;
    # every structural/control anchor and the full editor proof still follows.
    need(600 <= width <= 4096 and 480 <= height <= 4096 and width*height <= 12000000, 'SIZE_UNSUPPORTED')
    need(isinstance(digest,str) and len(digest)==64 and all(c in '0123456789abcdef' for c in digest), 'IMAGE_BINDING_INVALID')
    gray=cv2.cvtColor(pixels,cv2.COLOR_BGR2GRAY);s=dpi/120
    # Long structural edges survive independent width/height changes. DPI only
    # constrains plausible control sizes; it does not supply click coordinates.
    band=gray[round(height*.12):round(height*.93)].astype(np.int16)
    # The observed inactive dark window uses an exact four-level boundary.
    # All long-edge support, uniqueness and independent control checks remain.
    scores=(np.abs(np.diff(band,axis=1))>=4).mean(axis=0)
    edges=groups(np.where(scores>.78)[0]+1)
    nav=[v for v in edges if 45*s <= v[0] <= 110*s]
    need(len(nav)<=1,'NAVIGATION_BOUNDARY_UNCERTAIN')
    if nav:
        nav_x=nav[0][0];nav_evidence={'kind':'long-navigation-divider','support':round(float(scores[nav_x-1]),6)}
    else:
        nav_x,nav_evidence=neutral_navigation_boundary(pixels,round(height*.12),round(height*.93),s,allow_missing=True)
        if nav_x is None:
            # These early-return modes do not run the main window's complete
            # avatar/search cross-check. Do not silently inherit its new proof.
            need(not contact_panel and not recording_state,'NAVIGATION_GLYPHS_MODE_UNSUPPORTED')
            nav_x,nav_evidence=navigation_glyphs(gray,dpi)
    chats=[v for v in edges if nav_x+180*s <= v[0] <= min(nav_x+480*s,width-300*s) and max(scores[x-1] for x in v)>.94]
    need(chats and (len(chats)==1 or contact_panel),'CHAT_BOUNDARY_UNCERTAIN');chat_x=chats[0][0]
    need(float(np.median(gray[round(height*.2):round(height*.8),chat_x+5:chat_x+12])) < 70,'THEME_UNSUPPORTED')
    span=gray[:,chat_x+round(30*s):width-round(30*s)].astype(np.int16)
    horizontal=(np.abs(np.diff(span,axis=0))>2).mean(axis=1)
    separators=groups(np.where(horizontal>.95)[0]+1)
    top=[v for v in separators if 20*s <= v[0] <= 60*s]
    bottom=[v for v in separators if 70*s <= v[0] <= 125*s]
    need(len(top)==1 and len(bottom)<=1,'HEADER_BOUNDARY_UNCERTAIN')
    chrome_y=top[0][-1];header_banner=None
    if bottom:header_bottom=bottom[0][-1]
    else:
        need(not contact_panel,'HEADER_BOUNDARY_UNCERTAIN')
        header_bottom,header_banner=pinned_message_header(pixels,separators,chat_x,chrome_y,dpi)
    if contact_panel:
        need(not recording_state,'MODE_INVALID')
        return locate_contact_panel(pixels,digest,dpi,version,recognize,chat_x,chrome_y,header_bottom,recognize_scaled)
    avatar_region=rect(round(5*s),chrome_y,nav_x-round(5*s),header_bottom)
    avatar_pixels=pixels[avatar_region['top']:avatar_region['bottom'],avatar_region['left']:avatar_region['right']]
    background=np.median(avatar_pixels[:,:max(2,round(3*s))].reshape(-1,3),axis=0)
    contrast=(np.max(np.abs(avatar_pixels.astype(float)-background),axis=2)>25).astype(np.uint8)*255
    _,_,stats,_=cv2.connectedComponentsWithStats(contrast,8)
    avatars=[]
    for x,y,w,h,area in stats[1:]:
        if (33*s<=w<=60*s and 33*s<=h<=60*s and abs(w-h)<=3*s and area>=w*h*.8 and
                abs(avatar_region['left']+x+w/2-nav_x/2)<=5*s):
            avatars.append(rect(avatar_region['left']+x,avatar_region['top']+y,avatar_region['left']+x+w,avatar_region['top']+y+h))
    need(len(avatars)==1,'SELF_AVATAR_UNCERTAIN');avatar=avatars[0]
    if nav_evidence.get('method')=='known-glyph-constellation':
        center=(avatar['left']+avatar['right'])/2;scale=dpi/96
        need(all(abs((g['rect']['left']+g['rect']['right'])/2-center)<=1.5*scale for g in nav_evidence['glyphs'])
             and abs((nav_evidence['glyphs'][0]['rect']['top']+nav_evidence['glyphs'][0]['rect']['bottom'])/2-(avatar['top']+avatar['bottom'])/2-100*scale)<=4*scale,'NAVIGATION_GLYPHS_UNCERTAIN')
    editor_search=rect(chat_x,round(height*.45),width,height)
    frames=editor_frame_candidates(pixels,gray,editor_search,s)
    need(len(frames)==1,'EDITOR_FRAME_UNCERTAIN');frame=frames[0]
    toolbar=rect(frame['left']+round(5*s),frame['bottom']-round((65 if recording_state else 49)*s),frame['right']-round(5*s),frame['bottom']-round(4*s))
    base={'version':1,'ok':True,'executableVersion':version,'imageSha256':digest,'width':width,'height':height,'dpi':dpi,'readOnly':True,'inputSent':False,'emptyDraftAuthorized':False,'identityVerified':False,'recordingState':recording_state}
    templates=template_set() if templates is None else templates
    if recording_state:
        cancel,cancel_score=match_control(gray,toolbar,dpi,'cancel',templates)
        submit,submit_score=match_control(gray,toolbar,dpi,'submit',templates)
        need(cancel['right']+30*s < submit['left'] and submit['right']>width-90*s and abs(cancel['top']-submit['top'])<10*s,'RECORDING_ROLES_UNCERTAIN')
        base.update(anchors={'navDivider':nav_x,'chatDivider':chat_x,'editorFrame':frame,'toolbar':toolbar,'cancelRect':cancel,'submitRect':submit},evidence=[{'kind':'cancel-template','score':cancel_score},{'kind':'submit-template','score':submit_score}])
        return base
    record,record_score=match_control(gray,toolbar,dpi,'recordStart',templates)
    need(record['left']>frame['left']+(frame['right']-frame['left'])*.55 and record['right']<frame['right']-40*s,'RECORD_LOCATION_UNCERTAIN')
    search_area=rect(nav_x+round(7*s),chrome_y,chat_x-round(30*s),header_bottom)
    send_area=rect(record['right']+round(4*s),toolbar['top'],frame['right'],toolbar['bottom'])
    searches=rectangle_candidates(gray,search_area,130*s,350*s,23*s,45*s)
    need(len(searches)==1,'SEARCH_CONTROL_BOUNDARY_UNCERTAIN');search=searches[0]
    # The magnifier is a separate glyph, not part of the placeholder. The
    # button OCR gets surrounding vertical context; acceptance stays confined
    # to the structurally found bottom-right control, never chat bubbles.
    search_text=rect(search['left']+round(26*s),max(chrome_y,search['top']-round(5*s)),search['right']-round(3*s),min(header_bottom,search['bottom']+round(8*s)))
    send_context=rect(max(chat_x,record['left']-round(8*s)),max(frame['top'],toolbar['top']-round(18*s)),min(width,frame['right']+round(8*s)),min(height,frame['bottom']+round(8*s)))
    title_area=rect(chat_x+round(10*s),chrome_y+round(4*s),min(width-round(150*s),chat_x+round(320*s)),header_bottom-round(4*s))
    # Small text detection needs vertical context at the observed 96 DPI.
    # Choose the fixed transform before recognizing; never search transforms
    # for an expected label. Other DPIs retain their existing primary path.
    padded_search=dpi==96 and callable(recognize_padded)
    search_ocr=recognize_padded(search_text) if padded_search else recognize(search_text)
    send_ocr=recognize(send_context);title_ocr=recognize(title_area)
    for result in (search_ocr,send_ocr,title_ocr):
        need(result.get('imageSha256')==digest and result.get('width')==width and result.get('height')==height,'OCR_BINDING_INVALID')
    if padded_search:
        need(search_ocr.get('region')==search_text and search_ocr.get('layoutPreprocess')=='control-border-16','OCR_BINDING_INVALID')
    search_label,search_score,search_scaled=search_anchor(search_ocr,search_area,search,(lambda:recognize_scaled(search_text)) if callable(recognize_scaled) and not padded_search else None,search_text)
    send_label,send_score=anchor_words(send_ocr,'发送',send_area)
    title,title_score=title_anchor(title_ocr,title_area,(lambda:recognize_scaled(title_area)) if callable(recognize_scaled) else None)
    searches=[r for r in searches if label_in_control(r,search_label)]
    buttons=rectangle_candidates(gray,send_area,42*s,95*s,22*s,42*s)
    buttons=[r for r in buttons if label_in_control(r,send_label)]
    need(len(searches)==1 and len(buttons)==1,'LABEL_CONTROL_BOUNDARY_UNCERTAIN')
    search,send=searches[0],buttons[0]
    need(abs((record['top']+record['bottom'])/2-(send['top']+send['bottom'])/2)<8*s,'TOOLBAR_ALIGNMENT_UNCERTAIN')
    # Cover the entire content area inside the rounded frame, stopping at the
    # measured toolbar glyph row. Never take a blank corner as an empty draft.
    toolbar['top']=min(record['top'],send['top'])
    editor=rect(frame['left']+round(3*s),frame['top']+round(3*s),frame['right']-round(3*s),toolbar['top'])
    frame_evidence={'kind':'editor-rounded-frame','rect':frame}
    if dpi==96:
        inner=editor_inner_edges(gray,frame,toolbar,dpi)
        editor=rect(inner['left']['position'],inner['top']['position'],inner['right']['position'],toolbar['top'])
        frame_evidence.update(contentRect=editor,innerEdges=inner)
    need(editor['bottom']-editor['top'] >= 65*s,'EDITOR_CONTENT_UNCERTAIN')
    header=rect(chat_x+round(12*s),chrome_y+round(4*s),width-round(120*s),header_bottom-round(4*s))
    focus=blank_caption_region(gray,chat_x,chrome_y,dpi)
    base.update(layout={'header':header,'profileOpen':title,'selfOpen':avatar,'search':search,'editor':editor,'send':send,'focusActivateRect':focus},
        headerRgbaSha256=rgba_hash(pixels,header),titleRgbaSha256=rgba_hash(pixels,title),
        anchors={'navDivider':nav_x,'chatDivider':chat_x,'chromeBottom':chrome_y,'headerBottom':header_bottom,'editorFrame':frame,'toolbar':toolbar,'recordStartRect':record},
        unknown=['selfProfile','contactProfilePanel','searchResults','recordingButtons'],
        evidence=[nav_evidence,{'kind':'long-chat-divider','support':round(float(scores[chat_x-1]),6)},frame_evidence,{'kind':'search-label-and-control','confidence':round(search_score,6),'recognition':'control-border-16' if padded_search else 'control-cubic-1.25' if search_scaled else 'original'},{'kind':'send-label-and-control','confidence':round(send_score,6)},{'kind':'record-template','score':record_score},{'kind':'self-avatar-component','rect':avatar},{'kind':'chat-title-text','rect':title,'confidence':round(title_score,6),**({'headerBanner':header_banner} if header_banner else {})}],elapsedMs=round((time.monotonic()-started)*1000))
    return base


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--image',required=True);parser.add_argument('--dpi',required=True,type=int);parser.add_argument('--version',required=True);modes=parser.add_mutually_exclusive_group();modes.add_argument('--recording-state',action='store_true');modes.add_argument('--contact-panel',action='store_true');args=parser.parse_args()
    try:
        spec=importlib.util.spec_from_file_location('local_ocr',Path(__file__).with_name('local-ocr.py'));ocr=importlib.util.module_from_spec(spec);spec.loader.exec_module(ocr)
        ocr.check_runtime();sys.addaudithook(ocr.deny_network);pixels,digest=ocr.load_image(args.image)
        engine=None
        def recognize(region):
            nonlocal engine
            if engine is None:engine=ocr.create_engine('small')
            return ocr.recognize(pixels,digest,'small',region=region,engine=engine)
        def recognize_scaled(region):
            return scaled_control_pixels(pixels,digest,region,lambda resized:ocr.recognize(resized,digest,'small',engine=engine))
        def recognize_padded(region):
            nonlocal engine
            if engine is None:engine=ocr.create_engine('small')
            return padded_control_pixels(pixels,digest,region,lambda framed:ocr.recognize(framed,digest,'small',engine=engine))
        result=locate(pixels,digest,args.dpi,args.version,recognize,recording_state=args.recording_state,contact_panel=args.contact_panel,recognize_scaled=recognize_scaled,recognize_padded=recognize_padded)
    except Exception as error:
        code=str(error)
        if not code.startswith('LAYOUT_') or not all(c.isupper() or c=='_' for c in code):code='LAYOUT_UNAVAILABLE'
        result={'version':1,'ok':False,'code':code,'readOnly':True,'inputSent':False,'emptyDraftAuthorized':False,'identityVerified':False}
    print(json.dumps(result,ensure_ascii=True,separators=(',',':')))
    return 0 if result['ok'] else 2


if __name__=='__main__':
    raise SystemExit(main())
