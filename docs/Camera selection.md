# Camera selection

The face settings support three selection modes:

- **Individual cameras (legacy):** preserves the existing independent color and IR camera settings.
- **Priority:** selects the first configured pair whose color and IR streams are both connected. Put a dock camera first and the built-in camera second to support undocking.
- **Fixed pair:** uses only the selected pair. If it is disconnected, face authentication is unavailable.

Create pairs by selecting a color stream and its corresponding IR stream, then order the pairs in the settings. BioPass does not infer which streams belong together. Disconnected entries remain saved and can be selected again when reconnected.

New selections store libcamera identities rather than `/dev/videoN` numbers. These identities survive device-number changes, but moving a USB camera to another port or changing the dock topology may change its identity. Refresh the camera list and update the pair after such changes. Existing device-path settings remain supported.

Selection happens before authentication. Once selected, the pair remains fixed for that authentication session. A failed recognition, IR check, or camera start does not cause a switch to another pair. Pair modes require an IR stream even when the AI anti-spoofing model is disabled.

The application and authentication helper must be updated together: camera discovery uses the helper's `list-cameras` command.
