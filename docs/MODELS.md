# Model availability

The source and explicit simulation workflow are public. Original trained checkpoints were loaded and tested locally on a synthetic image, but they have not been uploaded publicly. A GitHub source link does not supply those weights.

Real inference requires optional inference dependencies plus the checkpoints at the relative paths in model-manifest.json. The manifest records the original sizes and SHA-256 digests for identity checks; it contains no model data. Supply compatible models you are authorised to use, or use the application's explicitly labelled simulation mode.

The release download helper exits with an explanatory message while original release assets are unavailable. It does not substitute simulated detections for a real-model request.
