import numpy as np

from app.processors.registration import estimate_registration


def test_translation_registration():
    result = estimate_registration({
        'anchors': [
            {'source': [0, 0, 0], 'target': [1, 2, 3]},
            {'source': [2, 0, 0], 'target': [3, 2, 3]},
        ]
    })
    assert result['method'] == 'ANCHOR_TRANSLATION'
    assert result['transform']['translationM'] == [1.0, 2.0, 3.0]
    assert result['diagnostics']['rmsErrorM'] == 0.0


def test_rigid_rotation_registration():
    # 90 degrees around Z plus translation [1,2,0]
    anchors = [
        {'source': [0, 0, 0], 'target': [1, 2, 0]},
        {'source': [1, 0, 0], 'target': [1, 3, 0]},
        {'source': [0, 1, 0], 'target': [0, 2, 0]},
        {'source': [1, 1, 0], 'target': [0, 3, 0]},
    ]
    result = estimate_registration({'anchors': anchors})
    matrix = np.asarray(result['transform']['matrix4'])
    assert result['method'] == 'ANCHOR_RIGID'
    assert result['confidence'] > 0.99
    assert np.allclose(matrix[:3, 3], [1, 2, 0], atol=1e-6)
    assert result['diagnostics']['rmsErrorM'] < 1e-6
