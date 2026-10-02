import unittest

import numpy as np
from skimage.transform import SimilarityTransform

from evaluate import REFERENCE, alignment_matrix, biopass_letterbox


class AlignmentTests(unittest.TestCase):
    def test_recovers_translation_rotation_and_scale(self):
        for angle in [-0.3, 0, 0.3]:
            forward = SimilarityTransform(scale=2, rotation=angle, translation=(43, 27))
            landmarks = forward(REFERENCE)
            matrix = alignment_matrix(landmarks)
            homogeneous = np.column_stack((landmarks, np.ones(5)))
            np.testing.assert_allclose(homogeneous @ matrix.T, REFERENCE, atol=1e-4)

    def test_rejects_degenerate_and_nonfinite_landmarks(self):
        for landmarks in [np.zeros((5, 2)), np.full((5, 2), np.nan), np.zeros((4, 2))]:
            with self.assertRaises(ValueError):
                alignment_matrix(landmarks)

    def test_rejects_inconsistent_landmarks(self):
        landmarks = REFERENCE.copy()
        landmarks[2] += 100
        with self.assertRaises(ValueError):
            alignment_matrix(landmarks)

    def test_letterbox_keeps_color_and_black_padding(self):
        image = np.full((40, 80, 3), [37, 149, 213], dtype=np.uint8)
        output = biopass_letterbox(image)
        np.testing.assert_array_equal(output[:28], 0)
        np.testing.assert_array_equal(output[84:], 0)
        np.testing.assert_array_equal(
            output[28:84], np.broadcast_to(image[0, 0], (56, 112, 3))
        )

    def test_letterbox_does_not_modify_square_native_resolution(self):
        image = np.random.default_rng(0).integers(0, 256, (112, 112, 3), dtype=np.uint8)
        np.testing.assert_array_equal(biopass_letterbox(image), image)


if __name__ == "__main__":
    unittest.main()
