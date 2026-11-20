import importlib.util
import unittest
from pathlib import Path
import numpy as np

spec = importlib.util.spec_from_file_location('popup', Path(__file__).with_name('qt_search_popup.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class SearchPopupTests(unittest.TestCase):
    def fixture(self, dx=0, dy=0):
        # Four public frame arcs only, no names, avatars, IDs or captured text.
        image = np.full((700, 900, 3), 80, dtype=np.uint8)
        left, top, right, bottom = 90+dx, 89+dy, 490+dx, 531+dy
        image[top:bottom, left:right] = 31
        image[top, left:right] = 47
        image[top+7:bottom-7, left] = 45
        image[top+7:bottom-7, right-1] = 45
        corner = np.array([[48,48,48,56,60,58,53,48,47],
                           [48,50,61,57,41,32,30,30,30],
                           [48,59,51,34,30,30,31,31,31],
                           [57,58,33,30,30,31,31,31,31],
                           [62,40,30,30,31,31,31,31,31],
                           [57,30,30,31,31,31,31,31,31],
                           [50,30,31,31,31,31,31,31,31],
                           [45,30,31,31,31,31,31,31,31],
                           [45,30,31,31,31,31,31,31,31]], dtype=np.uint8)
        corner = np.repeat(corner[:, :, None], 3, axis=2)
        image[top:top+9, left:left+9] = corner
        image[top:top+9, right-9:right] = corner[:, ::-1]
        image[bottom-8:bottom, left:left+9] = corner[1:][::-1]
        image[bottom-8:bottom, right-9:right] = corner[1:][::-1, ::-1]
        return image, {'left':60+dx, 'top':79+dy, 'right':520+dx, 'bottom':562+dy}, {'left':left,'top':top,'right':right,'bottom':bottom}

    def test_unique_complete_frame_and_translation(self):
        for dx, dy in [(0,0),(133,77),(-30,20)]:
            image, area, expected = self.fixture(dx,dy)
            self.assertEqual(module.search_popup_content(image, area, 120), expected)

    def test_missing_edges_and_changed_corners_are_rejected(self):
        for kind in ['left','right','top','bottom','corner','unrelated']:
            image, area, _ = self.fixture()
            if kind=='left': image[200,90] = 31
            if kind=='right': image[200,489] = 31
            if kind=='top': image[89,250] = 31
            if kind=='bottom': image[531,250] = 31
            if kind=='corner': image[93,94] = 120
            if kind=='unrelated': image[:] = 31
            with self.subTest(kind=kind), self.assertRaises(ValueError):
                module.search_popup_content(image, area, 120)

    def test_opaque_bottom_excludes_uniform_outer_blend_rows_without_choosing_larger_frame(self):
        # A neutral outer stripe over a flat background used to generate a
        # second complete-looking candidate one pixel taller. The actual body
        # is the row whose horizontal corner arc reaches its interior color.
        for dx,dy in [(0,0),(133,77),(-30,20)]:
            for stripes in [(36,),(41,),(60,),(41,60)]:
                image,area,expected=self.fixture(dx,dy)
                for offset,color in enumerate(stripes):
                    image[expected['bottom']+offset,expected['left']:expected['right']]=color
                with self.subTest(dx=dx,dy=dy,stripes=stripes):
                    self.assertEqual(module.search_popup_content(image,area,120),expected)

    def test_opaque_bottom_cannot_be_replaced_by_an_outside_stroke_or_overlong_arc(self):
        for kind in ['weak-outward-edge','overlong-left-arc','overlong-right-arc']:
            image,area,expected=self.fixture()
            if kind=='weak-outward-edge':image[expected['bottom'],expected['left']:expected['right']]=34
            elif kind=='overlong-left-arc':image[expected['bottom']-1,expected['left']:expected['left']+16]=45
            else:image[expected['bottom']-1,expected['right']-16:expected['right']]=45
            with self.subTest(kind=kind),self.assertRaises(ValueError):
                module.search_popup_content(image,area,120)

    def test_popup_bounds_and_dpi_are_validated(self):
        image, area, _ = self.fixture()
        for bad in [{**area,'left':-1},{**area,'right':1200},{**area,'left':60.0}]:
            with self.assertRaises(ValueError): module.search_popup_content(image,bad,120)
        for dpi in [0,95,241,120.0]:
            with self.assertRaises(ValueError): module.search_popup_content(image,area,dpi)

    def test_two_complete_nested_frames_are_ambiguous(self):
        image, area, _ = self.fixture()
        corner = image[89:98,90:99].copy()
        left, top, right, bottom = 110,109,470,511
        image[top:bottom,left:right] = 31
        image[top,left:right] = 47
        image[top+7:bottom-7,left] = 45
        image[top+7:bottom-7,right-1] = 45
        image[top:top+9,left:left+9] = corner
        image[top:top+9,right-9:right] = corner[:,::-1]
        image[bottom-8:bottom,left:left+9] = corner[1:][::-1]
        image[bottom-8:bottom,right-9:right] = corner[1:][::-1,::-1]
        image[bottom,left:right] = 80
        with self.assertRaisesRegex(ValueError,'^LAYOUT_SEARCH_POPUP_AMBIGUOUS$'):
            module.search_popup_content(image,area,120)


if __name__ == '__main__': unittest.main()
