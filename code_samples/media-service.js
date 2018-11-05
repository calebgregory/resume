import R from 'ramda';
import { EventEmitter } from 'events';

import MediaSource from '../interfaces/media-source';
import logger from '../utils/logger';

/*
  # (service) MediaService

  The `MediaService` is responsible for interacting with [the browser
  navigator.mediaDevices API](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices).
  It handles things such as getting a user's permission to use a media device,
  and emits events when devices are added or removed. It also exports helpers
  to handle interactions with MediaSources coming from media devices, such as
  `getMediaSourceForDevice(device)`.
*/

// media constraints
const VIDEO_HEIGHT_MIN_VALUE = 720;

// getUserMedia errors; taken from [MediaDevices.getUserMedia
// Exceptions](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia#Exceptions)
const PERMISSION_DISMISSED_ERROR_TYPE = 'PermissionDismissedError';
const PERMISSION_DENIED_ERROR_TYPE = 'PermissionDeniedError';
const NOT_ALLOWED_ERROR_TYPE = 'NotAllowedError';
const OVERCONSTRAINED_ERROR = 'OverconstrainedError';

// event types, to be emitted by MediaService
const PERMISSIONS_FAILURE = 'PERMISSIONS_FAILURE';
const DEVICE_FOUND = 'DEVICE_FOUND';
const DEVICE_REMOVED = 'DEVICE_REMOVED';

// [MediaDeviceInfo.kind](https://developer.mozilla.org/en-US/docs/Web/API/MediaDeviceInfo/kind)
export const deviceKinds = {
  audiooutput: 'audiooutput',
  audioinput: 'audioinput',
  videoinput: 'videoinput'
};

export const audioDeviceKinds = [ deviceKinds.audioinput, deviceKinds.audiooutput ];

/*
  private helper functions

  these are used by MediaService but do not utilize any values stored as
  properties on the MediaService (e.g., `this.state.deviceMap`).
*/

// _hasAudioAndVideoDevices :: ([]MediaDeviceInfo) => (hasAudioAndVideoDevices bool)
// takes list of devices and returns true if there is an `audioinput` and a
// `videoinput`
export const _hasAudioAndVideoDevices = (devices) => {
  let hasAudioInput = false;
  let hasVideoInput = false;

  devices.forEach((device) => {
    if (device.kind === deviceKinds.audioinput) {
      hasAudioInput = true;
    }
    if (device.kind === deviceKinds.videoinput) {
      hasVideoInput = true;
    }
  });

  return hasAudioInput && hasVideoInput;
}

// partiallyMatchesAnyLabel :: (configuredLabels []String, deviceLabel String) => (deviceLabelContainsConfiguredLabel bool)
// if deviceLabel contains any of the configured labels, returns true; else
// returns false.
export const partiallyMatchesAnyLabel = (configuredLabels, deviceLabel) => {
  for (var i = 0; i < configuredLabels.length; i++) {
    const configuredLabel = configuredLabels[i];
    if (deviceLabel.indexOf(configuredLabel) > -1) {
      return true;
    }
  }

  return false;
}

// _stopTracksOnStream :: (MediaStream) => undefined
// takes a stream and stops all the tracks on it
export const _stopTracksOnStream = (stream) => {
  stream.getTracks().forEach((track) => { track.stop() });
}

// _listDevices :: () => Promise(resolve{[]MediaDeviceInfo}, reject{Error})
// This can throw an error; see
// [example](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/enumerateDevices#Example)
const _listDevices = () => {
  return navigator.mediaDevices.enumerateDevices()
}

// _getUserMediaPermissions :: () => (wasSuccessful bool)
// we use MediaDevices.getUserMedia() to get user permission to use their media
// devices. for full documentation, see [Mozilla
// documentation](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia).
// If successful, return `true`. If unsuccessful, if thrown error is one of the
// errors we are handling, then rethrow it to be handled by the calling
// process. Otherwise, log error and return `false`.
export const _getUserMediaPermissions = async () => {
  const handleError = (message, error) => {
    if (R.contains(error.name)([ PERMISSION_DENIED_ERROR_TYPE, PERMISSION_DISMISSED_ERROR_TYPE, NOT_ALLOWED_ERROR_TYPE ])) {
      throw error;
    }
    logger.info({ message, error });
    return false;
  }

  // try getting HD streams first
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: { height: { min: VIDEO_HEIGHT_MIN_VALUE } } });
  } catch (error) {
    if (error.name !== OVERCONSTRAINED_ERROR) {
      return handleError(`Failed to get user media with height.min ${VIDEO_HEIGHT_MIN_VALUE}`, error);
    }
  }

  if (!stream) {
    // if there is an non-user-related error getting HD streams, try to get any stream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    } catch (error) {
      return handleError(`Failed to get user media of any dimension`, error);
    }
  }

  // stop tracks
  _stopTracksOnStream(stream);

  return true;
}


class MediaService extends EventEmitter {
  constructor({ specialAudioDeviceLabel, specialVideoDeviceLabels, isSpecialVideoDeviceInverted }) {
    super();

    this.specialAudioDeviceLabel = specialAudioDeviceLabel;
    this.specialVideoDeviceLabels = specialVideoDeviceLabels;
    this.isSpecialVideoDeviceInverted = isSpecialVideoDeviceInverted;

    this.state = {
      gumPermissionGranted: false,
      devices: [],
    };
  }

  // The `ondevicechange` subscription should only be registered
  // after the MediaService's start in the, albeit extremely unlikely,
  // case that the user adds or removes devices during the initialization
  // process.
  start = async () => {
    // init: updateDevices and emit added devices to listeners; add handler for
    // [ondevicechange hook provided by
    // navigator.mediaDevices](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/ondevicechange)
    navigator.mediaDevices.ondevicechange = (evt) => { this.updateDevicesAndEmit(); };

    return this.updateDevicesAndEmit();
  }

  getDevice = (deviceId) => {
    return R.find(R.propEq('deviceId', deviceId))(this.state.devices) || false;
  }

  getDevices = () => {
    return this.state.devices.slice();
  }

  updateDevices = async () => {
    let devices;
    try {
      // get devices to check for audio, video devices.  if we don't have
      // UserMediaPermissions, the devices gotten will not have labels.  we
      // need the devices' labels to identify them, so we must get
      // UserMediaPermissions successfully for the app to function.
      devices = await _listDevices();
    } catch (error) {
      // failed to enumerate devices, which apparently _can happen_...
      logger.info({
        message: 'MediaService.prototype.init listDevices error',
        error
      });
      return false;
    }

    const hasAudioAndVideoDevices = _hasAudioAndVideoDevices(devices);
    if (!hasAudioAndVideoDevices) {
      return false;
    }

    if (!this.state.gumPermissionGranted) {
      let gumPermissionGranted;
      try {
        gumPermissionGranted = await _getUserMediaPermissions();
      } catch (error) {
        const handled = this.handleGetUserMediaError(error);
        if (!handled) {
          throw error;
        } else {
          return false;
        }
      }
      this.state.gumPermissionGranted = gumPermissionGranted;
    }

    try {
      // get devices with labels
      devices = await _listDevices();
    } catch (error) {
      logger.info({
        message: 'MediaService.prototype.init listDevices error',
        error
      });
    }

    this.state.devices = R.map(this._toProcessedDevice)(devices);
  }

  // updates devices, then emits FOUND and REMOVED devices, one at a time.
  updateDevicesAndEmit = async () => {
    const oldDevices = this.getDevices();
    await this.updateDevices();
    const updatedDevices = this.getDevices();

    const sameDeviceId = (d1, d2) => d1.deviceId === d2.deviceId;
    const foundDevices = R.differenceWith(sameDeviceId, updatedDevices, oldDevices);
    const removedDevices = R.differenceWith(sameDeviceId, oldDevices, updatedDevices);

    foundDevices.forEach((foundDevice) => { this.emit(DEVICE_FOUND, foundDevice); });
    removedDevices.forEach((removedDevice) => { this.emit(DEVICE_REMOVED, removedDevice); });
  }

  // _toProcessedDevice adds metadata to a device according to its label. These
  // labels are configured using environment variables. This processing
  // occurs in `updateDevices`. The presence of these tags is critical to
  // the application functioning correctly.
  _toProcessedDevice = (_d) => {
    let d = R.clone(_d);
    if (
      R.contains(this.specialAudioDeviceLabel)(d.label)
      && d.kind === deviceKinds.audioinput
    ) {
      d.isSpecialAudioDevice = true;
      d.disableMediaStreamAudioProcessing = true;
    } else if (partiallyMatchesAnyLabel(this.specialVideoDeviceLabels, d.label)) {
      d.isViscaCam = true;
      d.isInverted = this.isSpecialVideoDeviceInverted;
    } else if (d.kind === deviceKinds.videoinput) {
      d.isInverted = false;
    }
    return d;
  }

  // handles GetUserMediaError by emitting an event indicating that error
  // occurred; maybe some other entity in the app knows how to handle that
  // error.  returns bool indicating whether or not the GetUserMediaError was
  // handled.
  handleGetUserMediaError = (error) => {
    switch (error.name) {
      case NOT_ALLOWED_ERROR_TYPE:
      case PERMISSION_DISMISSED_ERROR_TYPE:
      case PERMISSION_DENIED_ERROR_TYPE:
        this.emit(PERMISSIONS_FAILURE, error.name);
        return true;
      default:
        return false;
    }
  }
}

// stream helpers
export const helpers = {
  partiallyMatchesAnyLabel,
  // a `MediaSource` is an app-specific wrapper for a `MediaStream`'s tracks;
  // it provides an extention of a track that enables changing the Gain level
  // of an audio track.
  async getMediaSourceForDevice(device) {
    let stream;
    let constraints = { audio: false, video: false };

    switch (device.kind) {
      case deviceKinds.audiooutput:
      case deviceKinds.audioinput:
        constraints.audio = {deviceId: {exact: device.deviceId}};

        if (device.disableMediaStreamAudioProcessing) {
          // This is useful particularly in the case of streaming specialAudioDevice.
          // These keys change from time to time and they can break
          // getTrackForDevice.  TODO: Utilize
          // [MediaTrackSupportedContraints](https://developer.mozilla.org/en-US/docs/Web/API/MediaTrackSupportedConstraints)
          // to get what constraints are supported before disabling them
          constraints.audio = R.merge({
            echoCancellation: false,
            googEchoCancellation: false,
            googExperimentalEchoCancellation: false,
            googAutoGainControl: false,
            googExperimentalAutoGainControl: false,
            googNoiseSuppression: false,
            googExperimentalNoiseSuppression: false,
            googBeamforming: false,
            googHighpassFilter: false,
            googTypingNoiseDetection: false,
          }, constraints.audio);
        }

        stream = await navigator.mediaDevices.getUserMedia(constraints)
        break;

      case deviceKinds.videoinput:
        // try getting HD video stream
        constraints.video = {deviceId: {exact: device.deviceId}, height: {min: 720}, aspectRatio: 16/9};
        let success = false;

        try {
          stream = await navigator.mediaDevices.getUserMedia(constraints);
          success = true
        } catch(_err) {
          success = false;
        }
        if (success) {
          break;
        }

        // if getting HD fails, try getting medium resolution stream
        constraints.video = {deviceId: {exact: device.deviceId}, height: {min: 480, max: 719}, aspectRatio: 16/9};
        try {
          stream = await navigator.mediaDevices.getUserMedia(constraints);
          success = true
        } catch(_err) {
          success = false;
        }
        if (success) {
          break;
        }

        // if we were unable to get HD or medium resolution streams, throw error
        throw new Error(`mediaStream.helpers.getTrackForDevice failed to get stream for videoinput device with id="${device.deviceId}".`);

      default:
        throw new Error(`mediaStream.helpers.getTrackForDevice error: No implemention for getting track of type "${device.kind}".`);
    }

    const track = stream.getTracks()[0];
    const mediaSource = new MediaSource(track);
    return mediaSource;
  },
};

export const events = {
  PERMISSIONS_FAILURE,
  DEVICE_FOUND,
  DEVICE_REMOVED,
};

export const errors = {
  PERMISSION_DISMISSED_ERROR_TYPE,
  PERMISSION_DENIED_ERROR_TYPE,
  NOT_ALLOWED_ERROR_TYPE,
  OVERCONSTRAINED_ERROR
};

export default MediaService;

// example of instantiation
const mediaService = new MediaService({
  specialAudioDeviceLabel: "External Microphone",
  specialVideoDeviceLabels: ["Point-Zoom-Tilt Camera", "USB 3.0 Camera"],
  isSpecialVideoDeviceInverted: false,
});
