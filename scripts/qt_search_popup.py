"""Find the opaque search content body inside native shadow bounds, read-only.

The surrounding native popup remains covered by the caller's complete pixel
hash. Excluding its blended outer stroke from OCR does not exclude that stroke
from the later native input guard.
"""
import math


def search_popup_content(image, area, dpi):
    import numpy as np
    def need(value, code):
        if not value:
            raise ValueError('LAYOUT_' + code)
    height, width = image.shape[:2]
    need(type(area) is dict and set(area) == {'left', 'top', 'right', 'bottom'}
         and all(type(x) is int for x in area.values())
         and 0 <= area['left'] < area['right'] <= width
         and 0 <= area['top'] < area['bottom'] <= height, 'REGION_INVALID')
    need(type(dpi) is int and 96 <= dpi <= 240, 'DPI_UNSUPPORTED')
    a = image[area['top']:area['bottom'], area['left']:area['right'], :3].astype('int16')
    h, w = a.shape[:2]
    need(100 <= w <= 1600 and 60 <= h <= 3000, 'SEARCH_POPUP_UNCERTAIN')
    radius = math.ceil(12*dpi/96)

    def runs(mask):
        edges = np.flatnonzero(np.diff(np.r_[False, mask, False]))
        return zip(edges[::2], edges[1::2])

    verticals = []
    # Two long neutral border strokes must each continuously contrast with
    # their inward neighbour. Window shadow padding is never assumed constant.
    for x in (*range(1, w//3), *range(w*2//3, w-1)):
        direction = 1 if x < w//3 else -1
        line, inner = a[:, x], a[:, x+direction]
        colors, counts = np.unique(line, axis=0, return_counts=True)
        for color, count in zip(colors, counts):
            if count < h*.65 or int(color.max()-color.min()) > 3 or not 15 < int(color.min()) < 240:
                continue
            mask = (np.max(abs(line-color), axis=1) <= 1) & (line.min(1)-inner.max(1) >= 2)
            for top, bottom in runs(mask):
                if bottom-top >= h*.65:
                    verticals.append((x, int(top), int(bottom), color, direction))
    need(len(verticals) <= 16, 'SEARCH_POPUP_AMBIGUOUS')

    def rounded(crop):
        size = radius+2
        if min(crop.shape[:2]) < size*2:
            return False
        for bottom in (False, True):
            extents = []
            for right in (False, True):
                c = crop[::-1] if bottom else crop
                c = c[:, ::-1] if right else c
                c = c[:size, :size]
                bg = c[-1, -1]
                if int(bg.max()-bg.min()) > 3:
                    return False
                mask = np.max(abs(c-bg), axis=2) <= 2
                axes = []
                for axis, rows in enumerate((mask, mask.T)):
                    # The last non-background pixel describes the complete
                    # inward arc even when the outside background is similar.
                    edge = [int(np.flatnonzero(~row)[-1]+1) if not row.all() else 0 for row in rows]
                    # The bottom is the opaque inner cutoff, not an outer
                    # blended stroke. Its first horizontal row must reach the
                    # same interior background within the proved arc radius.
                    # Otherwise a uniform outer blend row can look like a
                    # second complete body one pixel taller. Top/side strokes
                    # have their own full-length border contrast proof above.
                    if bottom and axis == 0 and edge[0] > radius:
                        return False
                    if not (edge[0] >= 3 and 2 <= edge[1] <= radius and edge[-1] <= 1
                            and all(b <= a for a, b in zip(edge, edge[1:]))
                            and all(a-b <= 3 for a, b in zip(edge[1:], edge[2:]))
                            and all(value <= 1 for value in edge[radius:])):
                        return False
                    axes.append(edge)
                extents.append(axes)
            # Both left/right quarter arcs must agree at every original pixel.
            if any(abs(a-b) > 1 for aa, bb in zip(*extents) for a, b in zip(aa, bb)):
                return False
        return True

    found = []
    for left in verticals:
        for right in verticals:
            if (left[4] != 1 or right[4] != -1 or right[0]-left[0] < w*.55
                    or max(abs(left[1]-right[1]), abs(left[2]-right[2])) > 2
                    or int(np.max(abs(left[3]-right[3]))) > 3):
                continue
            middle = slice(left[0]+radius, right[0]-radius)
            tops, bottoms = [], []
            for y in range(max(1, left[1]-radius), min(h-1, left[2]+radius)):
                if left[1] <= y < left[2]:
                    continue
                row = a[y, middle]
                if y < left[1]:
                    if (np.all(np.max(abs(row-left[3]), axis=1) <= 3)
                            and np.all(row.min(1)-a[y+1, middle].max(1) >= 2)):
                        tops.append(y)
                # The bottom stroke may be alpha-blended with the desktop.
                # Prove the full flat inner edge plus its full outward contrast.
                elif (np.all(np.max(abs(row-row[len(row)//2]), axis=1) <= 1)
                      and np.all(a[y+1, middle].min(1)-row.max(1) >= 5)):
                    bottoms.append(y)
            for top in tops:
                for bottom in bottoms:
                    crop = a[top:bottom+1, left[0]:right[0]+1]
                    if rounded(crop):
                        found.append({'left': area['left']+left[0], 'top': area['top']+top,
                                      'right': area['left']+right[0]+1, 'bottom': area['top']+bottom+1})
    need(len(found) == 1, 'SEARCH_POPUP_UNCERTAIN' if not found else 'SEARCH_POPUP_AMBIGUOUS')
    return found[0]
