# Cameras and sign-in settings

Configure each camera once in the shared camera list. Give it a name such as Surface or Dock, choose its color stream, and optionally assign its corresponding IR stream. The camera card shows connection status and whether IR verification is configured; expand Camera settings to edit the assignment.

With one setup, BioPass uses that setup. With multiple setups, there are two selection policies:

- **Manual:** select the camera to use. If one of its assigned streams is disconnected, face authentication is unavailable.
- **Automatic:** enable Switch cameras automatically, then order the list by preference. BioPass uses the first setup whose assigned streams are connected. Put the dock first and the built-in camera second for docking and undocking.

BioPass does not infer which color and IR streams belong together. A configured IR stream is required for that setup and must pass its check, even when the AI protection is off. Selecting No IR camera explicitly creates a color-only setup. A disconnected IR camera never silently turns IR verification off.

Selection happens before authentication. Once selected, the setup remains fixed for that session. A failed recognition, IR check, or camera start does not switch to another setup.

## Existing settings and device identities

Old independent settings appear as Main camera in the form. Loading the page does not rewrite the configuration. Saving adopts the setup list while preserving the previous color and IR choices. A previously automatic color camera remains Automatic (existing setting), represented by `camera: auto`; choose a specific color stream to pin it. The backend resolves and pins that stream's identity before authentication too.

New explicit selections store libcamera identities rather than `/dev/videoN` numbers. These identities survive device-number changes, but moving a USB camera to another port or changing the dock topology may change its identity. Refresh the camera list and update the setup after such changes. Existing device-path settings remain supported. Disconnected entries remain saved.

The application and authentication helper must be updated together. Discovery uses the helper's `list-cameras` command.

## Related settings

- **Your face:** preview the selected color camera and manage photos used for recognition. Photo capture and deletion take effect immediately.
- **Photo & screen protection:** enable an independent AI check on the color image. This does not change IR verification assigned to a camera.
- **Advanced settings:** detection and recognition models, thresholds, and retry timing.
- **Sign-in behavior & system integration:** method order or parallel execution, diagnostics, exclusions, and the PAM setup guide.

Use Save to apply sign-in settings. Appearance is a separate, immediate preference: Light, Dark, or Follow system. Follow system stays selected while the displayed colors track the desktop's theme, including changes while the app is open.
