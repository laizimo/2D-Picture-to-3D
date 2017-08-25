(function() {
    'use strict'

    /**
     The ARController is the main object for doing AR marker detection with JSARToolKit.

     To use an ARController, you need to tell it the dimensions to use for the AR processing canvas and
     pass it an ARCameraParam to define the camera parameters to use when processing images.
     The ARCameraParam defines the lens distortion and aspect ratio of the camera used.
     See https://www.artoolworks.com/support/library/Calibrating_your_camera for more information about AR camera parameteters and how to make and use them.

     If you pass an image as the first argument, the ARController uses that as the image to process,
     using the dimensions of the image as AR processing canvas width and height. If the first argument
     to ARController is an image, the second argument is used as the camera param.

     The camera parameters argument can be either an ARCameraParam or an URL to a camera definition file.
     If the camera argument is an URL, it is loaded into a new ARCameraParam, and the ARController dispatches
     a 'load' event and calls the onload method if it is defined.

     @exports ARController
     @constructor

     @param {number} width The width of the images to process.
     @param {number} height The height of the images to process.
     @param {ARCameraParam | string} camera The ARCameraParam to use for image processing. If this is a string, the ARController treats it as an URL and tries to load it as a ARCameraParam definition file, calling ARController#onload on success.
     */
    var ARController = function(width, height, camera) {
        var id;
        var w = width, h = height;

        this.orientation = 'landscape';

        this.listeners = {};

        if (typeof width !== 'number') {
            var image = width;
            camera = height;
            w = image.videoWidth || image.width;
            h = image.videoHeight || image.height;
            this.image = image;
        }

        this.defaultMarkerWidth = 1;
        this.patternMarkers = {};
        this.barcodeMarkers = {};
        this.transform_mat = new Float32Array(16);

        this.canvas = document.createElement('canvas');
        this.canvas.width = w;
        this.canvas.height = h;
        this.ctx = this.canvas.getContext('2d');

        this.videoWidth = w;
        this.videoHeight = h;

        if (typeof camera === 'string') {

            var self = this;
            this.cameraParam = new ARCameraParam(camera, function() {
                self._initialize();
            }, function(err) {
                console.error("ARController: Failed to load ARCameraParam", err);
            });

        } else {

            this.cameraParam = camera;
            this._initialize();

        }
    };

    /**
     Destroys the ARController instance and frees all associated resources.
     After calling dispose, the ARController can't be used any longer. Make a new one if you need one.

     Calling this avoids leaking Emscripten memory, which may be important if you're using multiple ARControllers.
     */
    ARController.prototype.dispose = function() {
        artoolkit.teardown(this.id);

        for (var t in this) {
            this[t] = null;
        }
    };

    /**
     Detects markers in the given image. The process method dispatches marker detection events during its run.

     The marker detection process proceeds by first dispatching a markerNum event that tells you how many
     markers were found in the image. Next, a getMarker event is dispatched for each found marker square.
     Finally, getMultiMarker is dispatched for every found multimarker, followed by getMultiMarkerSub events
     dispatched for each of the markers in the multimarker.

     arController.addEventListener('markerNum', function(ev) {
				console.log("Detected " + ev.data + " markers.")
			});
     arController.addEventListener('getMarker', function(ev) {
				console.log("Detected marker with ids:", ev.data.marker.id, ev.data.marker.idPatt, ev.data.marker.idMatrix);
				console.log("Marker data", ev.data.marker);
				console.log("Marker transform matrix:", [].join.call(ev.data.matrix, ', '));
			});
     arController.addEventListener('getMultiMarker', function(ev) {
				console.log("Detected multimarker with id:", ev.data.multiMarkerId);
			});
     arController.addEventListener('getMultiMarkerSub', function(ev) {
				console.log("Submarker for " + ev.data.multiMarkerId, ev.data.markerIndex, ev.data.marker);
			});

     arController.process(image);


     If no image is given, defaults to this.image.

     If the debugSetup has been called, draws debug markers on the debug canvas.

     @param {ImageElement | VideoElement} image The image to process [optional].
     */
    ARController.prototype.process = function(image) {
        this.detectMarker(image);

        var markerNum = this.getMarkerNum();
        var k,o;
        for (k in this.patternMarkers) {
            o = this.patternMarkers[k]
            o.inPrevious = o.inCurrent;
            o.inCurrent = false;
        }
        for (k in this.barcodeMarkers) {
            o = this.barcodeMarkers[k]
            o.inPrevious = o.inCurrent;
            o.inCurrent = false;
        }

        for (var i=0; i<markerNum; i++) {
            var markerInfo = this.getMarker(i);

            var markerType = artoolkit.UNKNOWN_MARKER;
            var visible = this.trackPatternMarkerId(-1);

            if (markerInfo.idPatt > -1 && (markerInfo.id === markerInfo.idPatt || markerInfo.idMatrix === -1)) {
                visible = this.trackPatternMarkerId(markerInfo.idPatt);
                markerType = artoolkit.PATTERN_MARKER;

                if (markerInfo.dir !== markerInfo.dirPatt) {
                    this.setMarkerInfoDir(i, markerInfo.dirPatt);
                }

            } else if (markerInfo.idMatrix > -1) {
                visible = this.trackBarcodeMarkerId(markerInfo.idMatrix);
                markerType = artoolkit.BARCODE_MARKER;

                if (markerInfo.dir !== markerInfo.dirMatrix) {
                    this.setMarkerInfoDir(i, markerInfo.dirMatrix);
                }
            }

            if (markerType !== artoolkit.UNKNOWN_MARKER && visible.inPrevious) {
                this.getTransMatSquareCont(i, visible.markerWidth, visible.matrix, visible.matrix);
            } else {
                this.getTransMatSquare(i, visible.markerWidth, visible.matrix);
            }

            visible.inCurrent = true;
            this.transMatToGLMat(visible.matrix, this.transform_mat);
            this.dispatchEvent({
                name: 'getMarker',
                target: this,
                data: {
                    index: i,
                    type: markerType,
                    marker: markerInfo,
                    matrix: this.transform_mat
                }
            });
        }

        var multiMarkerCount = this.getMultiMarkerCount();
        for (var i=0; i<multiMarkerCount; i++) {
            var subMarkerCount = this.getMultiMarkerPatternCount(i);
            var visible = false;

            artoolkit.getTransMatMultiSquareRobust(this.id, i);
            this.transMatToGLMat(this.marker_transform_mat, this.transform_mat);
            for (var j=0; j<subMarkerCount; j++) {
                var multiEachMarkerInfo = this.getMultiEachMarker(i, j);
                if (multiEachMarkerInfo.visible >= 0) {
                    visible = true;
                    this.dispatchEvent({
                        name: 'getMultiMarker',
                        target: this,
                        data: {
                            multiMarkerId: i,
                            matrix: this.transform_mat
                        }
                    });
                    break;
                }
            }
            if (visible) {
                for (var j=0; j<subMarkerCount; j++) {
                    var multiEachMarkerInfo = this.getMultiEachMarker(i, j);
                    this.transMatToGLMat(this.marker_transform_mat, this.transform_mat);
                    this.dispatchEvent({
                        name: 'getMultiMarkerSub',
                        target: this,
                        data: {
                            multiMarkerId: i,
                            markerIndex: j,
                            marker: multiEachMarkerInfo,
                            matrix: this.transform_mat
                        }
                    });
                }
            }
        }
        if (this._bwpointer) {
            this.debugDraw();
        }
    };

    /**
     Adds the given pattern marker ID to the index of tracked IDs.
     Sets the markerWidth for the pattern marker to markerWidth.

     Used by process() to implement continuous tracking,
     keeping track of the marker's transformation matrix
     and customizable marker widths.

     @param {number} id ID of the pattern marker to track.
     @param {number} markerWidth The width of the marker to track.
     @return {Object} The marker tracking object.
     */
    ARController.prototype.trackPatternMarkerId = function(id, markerWidth) {
        var obj = this.patternMarkers[id];
        if (!obj) {
            this.patternMarkers[id] = obj = {
                inPrevious: false,
                inCurrent: false,
                matrix: new Float32Array(12),
                markerWidth: markerWidth || this.defaultMarkerWidth
            };
        }
        if (markerWidth) {
            obj.markerWidth = markerWidth;
        }
        return obj;
    };

    /**
     Adds the given barcode marker ID to the index of tracked IDs.
     Sets the markerWidth for the pattern marker to markerWidth.

     Used by process() to implement continuous tracking,
     keeping track of the marker's transformation matrix
     and customizable marker widths.

     @param {number} id ID of the barcode marker to track.
     @param {number} markerWidth The width of the marker to track.
     @return {Object} The marker tracking object.
     */
    ARController.prototype.trackBarcodeMarkerId = function(id, markerWidth) {
        var obj = this.barcodeMarkers[id];
        if (!obj) {
            this.barcodeMarkers[id] = obj = {
                inPrevious: false,
                inCurrent: false,
                matrix: new Float32Array(12),
                markerWidth: markerWidth || this.defaultMarkerWidth
            };
        }
        if (markerWidth) {
            obj.markerWidth = markerWidth;
        }
        return obj;
    };

    /**
     Returns the number of multimarkers registered on this ARController.

     @return {number} Number of multimarkers registered.
     */
    ARController.prototype.getMultiMarkerCount = function() {
        return artoolkit.getMultiMarkerCount(this.id);
    };

    /**
     Returns the number of markers in the multimarker registered for the given multiMarkerId.

     @param {number} multiMarkerId The id number of the multimarker to access. Given by loadMultiMarker.
     @return {number} Number of markers in the multimarker. Negative value indicates failure to find the multimarker.
     */
    ARController.prototype.getMultiMarkerPatternCount = function(multiMarkerId) {
        return artoolkit.getMultiMarkerNum(this.id, multiMarkerId);
    };

    /**
     Add an event listener on this ARController for the named event, calling the callback function
     whenever that event is dispatched.

     Possible events are:
     * getMarker - dispatched whenever process() finds a square marker
     * getMultiMarker - dispatched whenever process() finds a visible registered multimarker
     * getMultiMarkerSub - dispatched by process() for each marker in a visible multimarker
     * load - dispatched when the ARController is ready to use (useful if passing in a camera URL in the constructor)

     @param {string} name Name of the event to listen to.
     @param {function} callback Callback function to call when an event with the given name is dispatched.
     */
    ARController.prototype.addEventListener = function(name, callback) {
        if (!this.listeners[name]) {
            this.listeners[name] = [];
        }
        this.listeners[name].push(callback);
    };

    /**
     Remove an event listener from the named event.

     @param {string} name Name of the event to stop listening to.
     @param {function} callback Callback function to remove from the listeners of the named event.
     */
    ARController.prototype.removeEventListener = function(name, callback) {
        if (this.listeners[name]) {
            var index = this.listeners[name].indexOf(callback);
            if (index > -1) {
                this.listeners[name].splice(index, 1);
            }
        }
    };

    /**
     Dispatches the given event to all registered listeners on event.name.

     @param {Object} event Event to dispatch.
     */
    ARController.prototype.dispatchEvent = function(event) {
        var listeners = this.listeners[event.name];
        if (listeners) {
            for (var i=0; i<listeners.length; i++) {
                listeners[i].call(this, event);
            }
        }
    };

    /**
     Sets up a debug canvas for the AR detection. Draws a red marker on top of each detected square in the image.

     The debug canvas is added to document.body.
     */
    ARController.prototype.debugSetup = function() {
        document.body.appendChild(this.canvas)
        this.setDebugMode(1);
        this._bwpointer = this.getProcessingImage();
    };

    /**
     Loads a pattern marker from the given URL and calls the onSuccess callback with the UID of the marker.

     arController.loadMarker(markerURL, onSuccess, onError);

     @param {string} markerURL - The URL of the marker pattern file to load.
     @param {function} onSuccess - The success callback. Called with the id of the loaded marker on a successful load.
     @param {function} onError - The error callback. Called with the encountered error if the load fails.
     */
    ARController.prototype.loadMarker = function(markerURL, onSuccess, onError) {
        return artoolkit.addMarker(this.id, markerURL, onSuccess, onError);
    };

    /**
     Loads a multimarker from the given URL and calls the onSuccess callback with the UID of the marker.

     arController.loadMultiMarker(markerURL, onSuccess, onError);

     @param {string} markerURL - The URL of the multimarker pattern file to load.
     @param {function} onSuccess - The success callback. Called with the id and the number of sub-markers of the loaded marker on a successful load.
     @param {function} onError - The error callback. Called with the encountered error if the load fails.
     */
    ARController.prototype.loadMultiMarker = function(markerURL, onSuccess, onError) {
        return artoolkit.addMultiMarker(this.id, markerURL, onSuccess, onError);
    };

    /**
     * Populates the provided float array with the current transformation for the specified marker. After
     * a call to detectMarker, all marker information will be current. Marker transformations can then be
     * checked.
     * @param {number} markerUID	The unique identifier (UID) of the marker to query
     * @param {number} markerWidth	The width of the marker
     * @param {Float64Array} dst	The float array to populate with the 3x4 marker transformation matrix
     * @return	{Float64Array} The dst array.
     */
    ARController.prototype.getTransMatSquare = function(markerIndex, markerWidth, dst) {
        artoolkit.getTransMatSquare(this.id, markerIndex, markerWidth);
        dst.set(this.marker_transform_mat);
        return dst;
    };

    /**
     * Populates the provided float array with the current transformation for the specified marker, using
     * previousMarkerTransform as the previously detected transformation. After
     * a call to detectMarker, all marker information will be current. Marker transformations can then be
     * checked.
     * @param {number} markerUID	The unique identifier (UID) of the marker to query
     * @param {number} markerWidth	The width of the marker
     * @param {Float64Array} previousMarkerTransform	The float array to use as the previous 3x4 marker transformation matrix
     * @param {Float64Array} dst	The float array to populate with the 3x4 marker transformation matrix
     * @return	{Float64Array} The dst array.
     */
    ARController.prototype.getTransMatSquareCont = function(markerIndex, markerWidth, previousMarkerTransform, dst) {
        this.marker_transform_mat.set(previousMarkerTransform)
        artoolkit.getTransMatSquareCont(this.id, markerIndex, markerWidth);
        dst.set(this.marker_transform_mat);
        return dst;
    };

    /**
     * Populates the provided float array with the current transformation for the specified multimarker. After
     * a call to detectMarker, all marker information will be current. Marker transformations can then be
     * checked.
     *
     * @param {number} markerUID	The unique identifier (UID) of the marker to query
     * @param {number} markerWidth	The width of the marker
     * @param {Float64Array} dst	The float array to populate with the 3x4 marker transformation matrix
     * @return	{Float64Array} The dst array.
     */
    ARController.prototype.getTransMatMultiSquare = function(multiMarkerId, dst) {
        artoolkit.getTransMatMultiSquare(this.id, multiMarkerId);
        dst.set(this.marker_transform_mat);
        return dst;
    };

    /**
     * Populates the provided float array with the current robust transformation for the specified multimarker. After
     * a call to detectMarker, all marker information will be current. Marker transformations can then be
     * checked.
     * @param {number} markerUID	The unique identifier (UID) of the marker to query
     * @param {number} markerWidth	The width of the marker
     * @param {Float64Array} dst	The float array to populate with the 3x4 marker transformation matrix
     * @return	{Float64Array} The dst array.
     */
    ARController.prototype.getTransMatMultiSquareRobust = function(multiMarkerId, dst) {
        artoolkit.getTransMatMultiSquare(this.id, multiMarkerId);
        dst.set(this.marker_transform_mat);
        return dst;
    };

    /**
     Converts the given 3x4 marker transformation matrix in the 12-element transMat array
     into a 4x4 WebGL matrix and writes the result into the 16-element glMat array.

     If scale parameter is given, scales the transform of the glMat by the scale parameter.

     @param {Float64Array} transMat The 3x4 marker transformation matrix.
     @param {Float64Array} glMat The 4x4 GL transformation matrix.
     @param {number} scale The scale for the transform.
     */
    ARController.prototype.transMatToGLMat = function(transMat, glMat, scale) {
        glMat[0 + 0*4] = transMat[0]; // R1C1
        glMat[0 + 1*4] = transMat[1]; // R1C2
        glMat[0 + 2*4] = transMat[2];
        glMat[0 + 3*4] = transMat[3];
        glMat[1 + 0*4] = transMat[4]; // R2
        glMat[1 + 1*4] = transMat[5];
        glMat[1 + 2*4] = transMat[6];
        glMat[1 + 3*4] = transMat[7];
        glMat[2 + 0*4] = transMat[8]; // R3
        glMat[2 + 1*4] = transMat[9];
        glMat[2 + 2*4] = transMat[10];
        glMat[2 + 3*4] = transMat[11];
        glMat[3 + 0*4] = 0.0;
        glMat[3 + 1*4] = 0.0;
        glMat[3 + 2*4] = 0.0;
        glMat[3 + 3*4] = 1.0;
        if (scale != undefined && scale !== 0.0) {
            glMat[12] *= scale;
            glMat[13] *= scale;
            glMat[14] *= scale;
        }
        return glMat;
    };

    /**
     This is the core ARToolKit marker detection function. It calls through to a set of
     internal functions to perform the key marker detection steps of binarization and
     labelling, contour extraction, and template matching and/or matrix code extraction.

     Typically, the resulting set of detected markers is retrieved by calling arGetMarkerNum
     to get the number of markers detected and arGetMarker to get an array of ARMarkerInfo
     structures with information on each detected marker, followed by a step in which
     detected markers are possibly examined for some measure of goodness of match (e.g. by
     examining the match confidence value) and pose extraction.

     @param {image} Image to be processed to detect markers.
     @return {number}     0 if the function proceeded without error, or a value less than 0 in case of error.
     A result of 0 does not however, imply any markers were detected.
     */
    ARController.prototype.detectMarker = function(image) {
        if (this._copyImageToHeap(image)) {
            return artoolkit.detectMarker(this.id);
        }
        return -99;
    };

    /**
     Get the number of markers detected in a video frame.

     @return {number}     The number of detected markers in the most recent image passed to arDetectMarker.
     Note that this is actually a count, not an index. A better name for this function would be
     arGetDetectedMarkerCount, but the current name lives on for historical reasons.
     */
    ARController.prototype.getMarkerNum = function() {
        return artoolkit.getMarkerNum(this.id);
    };

    /**
     Get the marker info struct for the given marker index in detected markers.

     Call this.detectMarker first, then use this.getMarkerNum to get the detected marker count.

     The returned object is the global artoolkit.markerInfo object and will be overwritten
     by subsequent calls. If you need to hang on to it, create a copy using this.cloneMarkerInfo();

     Returns undefined if no marker was found.

     A markerIndex of -1 is used to access the global custom marker.

     The fields of the markerInfo struct are:
     @field      area Area in pixels of the largest connected region, comprising the marker border and regions connected to it. Note that this is
     not the same as the actual onscreen area inside the marker border.
     @field      id If pattern detection mode is either pattern mode OR matrix but not both, will be marker ID (>= 0) if marker is valid, or -1 if invalid.
     @field      idPatt If pattern detection mode includes a pattern mode, will be marker ID (>= 0) if marker is valid, or -1 if invalid.
     @field      idMatrix If pattern detection mode includes a matrix mode, will be marker ID (>= 0) if marker is valid, or -1 if invalid.
     @field      dir If pattern detection mode is either pattern mode OR matrix but not both, and id != -1, will be marker direction (range 0 to 3, inclusive).
     @field      dirPatt If pattern detection mode includes a pattern mode, and id != -1, will be marker direction (range 0 to 3, inclusive).
     @field      dirMatrix If pattern detection mode includes a matrix mode, and id != -1, will be marker direction (range 0 to 3, inclusive).
     @field      cf If pattern detection mode is either pattern mode OR matrix but not both, will be marker matching confidence (range 0.0 to 1.0 inclusive) if marker is valid, or -1.0 if marker is invalid.
     @field      cfPatt If pattern detection mode includes a pattern mode, will be marker matching confidence (range 0.0 to 1.0 inclusive) if marker is valid, or -1.0 if marker is invalid.
     @field      cfMatrix If pattern detection mode includes a matrix mode, will be marker matching confidence (range 0.0 to 1.0 inclusive) if marker is valid, or -1.0 if marker is invalid.
     @field      pos 2D position (in camera image coordinates, origin at top-left) of the centre of the marker.
     @field      line Line equations for the 4 sides of the marker.
     @field      vertex 2D positions (in camera image coordinates, origin at top-left) of the corners of the marker. vertex[(4 - dir)%4][] is the top-left corner of the marker. Other vertices proceed clockwise from this. These are idealised coordinates (i.e. the onscreen position aligns correctly with the undistorted camera image.)


     @param {number} markerIndex The index of the marker to query.
     @returns {Object} The markerInfo struct.
     */
    ARController.prototype.getMarker = function(markerIndex) {
        if (0 === artoolkit.getMarker(this.id, markerIndex)) {
            return artoolkit.markerInfo;
        }
    };

    /**
     Set marker vertices to the given vertexData[4][2] array.

     Sets the marker pos to the center of the vertices.

     Useful for building custom markers for getTransMatSquare.

     A markerIndex of -1 is used to access the global custom marker.

     @param {number} markerIndex The index of the marker to edit.
     */
    ARController.prototype.setMarkerInfoVertex = function(markerIndex, vertexData) {
        for (var i=0; i<vertexData.length; i++) {
            this.marker_transform_mat[i*2+0] = vertexData[i][0];
            this.marker_transform_mat[i*2+1] = vertexData[i][1];
        }
        return artoolkit.setMarkerInfoVertex(this.id, markerIndex);
    };

    /**
     Makes a deep copy of the given marker info.

     @param {Object} markerInfo The marker info object to copy.
     @return {Object} The new copy of the marker info.
     */
    ARController.prototype.cloneMarkerInfo = function(markerInfo) {
        return JSON.parse(JSON.stringify(markerInfo));
    };

    /**
     Get the marker info struct for the given marker index in detected markers.

     Call this.detectMarker first, then use this.getMarkerNum to get the detected marker count.

     The returned object is the global artoolkit.markerInfo object and will be overwritten
     by subsequent calls. If you need to hang on to it, create a copy using this.cloneMarkerInfo();

     Returns undefined if no marker was found.

     @field {number} pattId The index of the marker.
     @field {number} pattType The type of the marker. Either AR_MULTI_PATTERN_TYPE_TEMPLATE or AR_MULTI_PATTERN_TYPE_MATRIX.
     @field {number} visible 0 or larger if the marker is visible
     @field {number} width The width of the marker.

     @param {number} multiMarkerId The multimarker to query.
     @param {number} markerIndex The index of the marker to query.
     @returns {Object} The markerInfo struct.
     */
    ARController.prototype.getMultiEachMarker = function(multiMarkerId, markerIndex) {
        if (0 === artoolkit.getMultiEachMarker(this.id, multiMarkerId, markerIndex)) {
            return artoolkit.multiEachMarkerInfo;
        }
    };


    /**
     Returns the 16-element WebGL transformation matrix used by ARController.process to
     pass marker WebGL matrices to event listeners.

     Unique to each ARController.

     @return {Float64Array} The 16-element WebGL transformation matrix used by the ARController.
     */
    ARController.prototype.getTransformationMatrix = function() {
        return this.transform_mat;
    };

    /**
     * Returns the projection matrix computed from camera parameters for the ARController.
     *
     * @return {Float64Array} The 16-element WebGL camera matrix for the ARController camera parameters.
     */
    ARController.prototype.getCameraMatrix = function() {
        return this.camera_mat;
    };

    /**
     Returns the shared ARToolKit 3x4 marker transformation matrix, used for passing and receiving
     marker transforms to/from the Emscripten side.

     @return {Float64Array} The 12-element 3x4 row-major marker transformation matrix used by ARToolKit.
     */
    ARController.prototype.getMarkerTransformationMatrix = function() {
        return this.marker_transform_mat;
    };


    /* Setter / Getter Proxies */

    /**
     * Enables or disables debug mode in the tracker. When enabled, a black and white debug
     * image is generated during marker detection. The debug image is useful for visualising
     * the binarization process and choosing a threshold value.
     * @param {number} debug		true to enable debug mode, false to disable debug mode
     * @see				getDebugMode()
     */
    ARController.prototype.setDebugMode = function(mode) {
        return artoolkit.setDebugMode(this.id, mode);
    };

    /**
     * Returns whether debug mode is currently enabled.
     * @return			true when debug mode is enabled, false when debug mode is disabled
     * @see				setDebugMode()
     */
    ARController.prototype.getDebugMode = function() {
        return artoolkit.getDebugMode(this.id);
    };

    /**
     Returns the Emscripten HEAP offset to the debug processing image used by ARToolKit.

     @return {number} HEAP offset to the debug processing image.
     */
    ARController.prototype.getProcessingImage = function() {
        return artoolkit.getProcessingImage(this.id);
    }

    /**
     Sets the logging level to use by ARToolKit.

     @param
     */
    ARController.prototype.setLogLevel = function(mode) {
        return artoolkit.setLogLevel(mode);
    };

    ARController.prototype.getLogLevel = function() {
        return artoolkit.getLogLevel();
    };

    ARController.prototype.setMarkerInfoDir = function(markerIndex, dir) {
        return artoolkit.setMarkerInfoDir(this.id, markerIndex, dir);
    };

    ARController.prototype.setProjectionNearPlane = function(value) {
        return artoolkit.setProjectionNearPlane(this.id, value);
    };

    ARController.prototype.getProjectionNearPlane = function() {
        return artoolkit.getProjectionNearPlane(this.id);
    };

    ARController.prototype.setProjectionFarPlane = function(value) {
        return artoolkit.setProjectionFarPlane(this.id, value);
    };

    ARController.prototype.getProjectionFarPlane = function() {
        return artoolkit.getProjectionFarPlane(this.id);
    };


    /**
     Set the labeling threshold mode (auto/manual).

     @param {number}		mode An integer specifying the mode. One of:
     AR_LABELING_THRESH_MODE_MANUAL,
     AR_LABELING_THRESH_MODE_AUTO_MEDIAN,
     AR_LABELING_THRESH_MODE_AUTO_OTSU,
     AR_LABELING_THRESH_MODE_AUTO_ADAPTIVE,
     AR_LABELING_THRESH_MODE_AUTO_BRACKETING
     */
    ARController.prototype.setThresholdMode = function(mode) {
        return artoolkit.setThresholdMode(this.id, mode);
    };

    /**
     * Gets the current threshold mode used for image binarization.
     * @return	{number}		The current threshold mode
     * @see				getVideoThresholdMode()
     */
    ARController.prototype.getThresholdMode = function() {
        return artoolkit.getThresholdMode(this.id);
    };

    /**
     Set the labeling threshhold.

     This function forces sets the threshold value.
     The default value is AR_DEFAULT_LABELING_THRESH which is 100.

     The current threshold mode is not affected by this call.
     Typically, this function is used when labeling threshold mode
     is AR_LABELING_THRESH_MODE_MANUAL.

     The threshold value is not relevant if threshold mode is
     AR_LABELING_THRESH_MODE_AUTO_ADAPTIVE.

     Background: The labeling threshold is the value which
     the AR library uses to differentiate between black and white
     portions of an ARToolKit marker. Since the actual brightness,
     contrast, and gamma of incoming images can vary signficantly
     between different cameras and lighting conditions, this
     value typically needs to be adjusted dynamically to a
     suitable midpoint between the observed values for black
     and white portions of the markers in the image.

     @param {number}     thresh An integer in the range [0,255] (inclusive).
     */
    ARController.prototype.setThreshold = function(threshold) {
        return artoolkit.setThreshold(this.id, threshold);
    };

    /**
     Get the current labeling threshold.

     This function queries the current labeling threshold. For,
     AR_LABELING_THRESH_MODE_AUTO_MEDIAN, AR_LABELING_THRESH_MODE_AUTO_OTSU,
     and AR_LABELING_THRESH_MODE_AUTO_BRACKETING
     the threshold value is only valid until the next auto-update.

     The current threshold mode is not affected by this call.

     The threshold value is not relevant if threshold mode is
     AR_LABELING_THRESH_MODE_AUTO_ADAPTIVE.

     @return {number} The current threshold value.
     */
    ARController.prototype.getThreshold = function() {
        return artoolkit.getThreshold(this.id);
    };


    /**
     Set the pattern detection mode

     The pattern detection determines the method by which ARToolKit
     matches detected squares in the video image to marker templates
     and/or IDs. ARToolKit v4.x can match against pictorial "template" markers,
     whose pattern files are created with the mk_patt utility, in either colour
     or mono, and additionally can match against 2D-barcode-type "matrix"
     markers, which have an embedded marker ID. Two different two-pass modes
     are also available, in which a matrix-detection pass is made first,
     followed by a template-matching pass.

     @param {number} mode
     Options for this field are:
     AR_TEMPLATE_MATCHING_COLOR
     AR_TEMPLATE_MATCHING_MONO
     AR_MATRIX_CODE_DETECTION
     AR_TEMPLATE_MATCHING_COLOR_AND_MATRIX
     AR_TEMPLATE_MATCHING_MONO_AND_MATRIX
     The default mode is AR_TEMPLATE_MATCHING_COLOR.
     */
    ARController.prototype.setPatternDetectionMode = function(value) {
        return artoolkit.setPatternDetectionMode(this.id, value);
    };

    /**
     Returns the current pattern detection mode.

     @return {number} The current pattern detection mode.
     */
    ARController.prototype.getPatternDetectionMode = function() {
        return artoolkit.getPatternDetectionMode(this.id);
    };

    /**
     Set the size and ECC algorithm to be used for matrix code (2D barcode) marker detection.

     When matrix-code (2D barcode) marker detection is enabled (see arSetPatternDetectionMode)
     then the size of the barcode pattern and the type of error checking and correction (ECC)
     with which the markers were produced can be set via this function.

     This setting is global to a given ARHandle; It is not possible to have two different matrix
     code types in use at once.

     @param      type The type of matrix code (2D barcode) in use. Options include:
     AR_MATRIX_CODE_3x3
     AR_MATRIX_CODE_3x3_HAMMING63
     AR_MATRIX_CODE_3x3_PARITY65
     AR_MATRIX_CODE_4x4
     AR_MATRIX_CODE_4x4_BCH_13_9_3
     AR_MATRIX_CODE_4x4_BCH_13_5_5
     The default mode is AR_MATRIX_CODE_3x3.
     */
    ARController.prototype.setMatrixCodeType = function(value) {
        return artoolkit.setMatrixCodeType(this.id, value);
    };

    /**
     Returns the current matrix code (2D barcode) marker detection type.

     @return {number} The current matrix code type.
     */
    ARController.prototype.getMatrixCodeType = function() {
        return artoolkit.getMatrixCodeType(this.id);
    };

    /**
     Select between detection of black markers and white markers.

     ARToolKit's labelling algorithm can work with both black-bordered
     markers on a white background (AR_LABELING_BLACK_REGION) or
     white-bordered markers on a black background (AR_LABELING_WHITE_REGION).
     This function allows you to specify the type of markers to look for.
     Note that this does not affect the pattern-detection algorith
     which works on the interior of the marker.

     @param {number}      mode
     Options for this field are:
     AR_LABELING_WHITE_REGION
     AR_LABELING_BLACK_REGION
     The default mode is AR_LABELING_BLACK_REGION.
     */
    ARController.prototype.setLabelingMode = function(value) {
        return artoolkit.setLabelingMode(this.id, value);
    };

    /**
     Enquire whether detection is looking for black markers or white markers.

     See discussion for setLabelingMode.

     @result {number} The current labeling mode.
     */
    ARController.prototype.getLabelingMode = function() {
        return artoolkit.getLabelingMode(this.id);
    };

    /**
     Set the width/height of the marker pattern space, as a proportion of marker width/height.

     @param {number}		pattRatio The the width/height of the marker pattern space, as a proportion of marker
     width/height. To set the default, pass AR_PATT_RATIO.
     If compatibility with ARToolKit verions 1.0 through 4.4 is required, this value
     must be 0.5.
     */
    ARController.prototype.setPattRatio = function(value) {
        return artoolkit.setPattRatio(this.id, value);
    };

    /**
     Returns the current ratio of the marker pattern to the total marker size.

     @return {number} The current pattern ratio.
     */
    ARController.prototype.getPattRatio = function() {
        return artoolkit.getPattRatio(this.id);
    };

    /**
     Set the image processing mode.

     When the image processing mode is AR_IMAGE_PROC_FRAME_IMAGE,
     ARToolKit processes all pixels in each incoming image
     to locate markers. When the mode is AR_IMAGE_PROC_FIELD_IMAGE,
     ARToolKit processes pixels in only every second pixel row and
     column. This is useful both for handling images from interlaced
     video sources (where alternate lines are assembled from alternate
     fields and thus have one field time-difference, resulting in a
     "comb" effect) such as Digital Video cameras.
     The effective reduction by 75% in the pixels processed also
     has utility in accelerating tracking by effectively reducing
     the image size to one quarter size, at the cost of pose accuraccy.

     @param {number} mode
     Options for this field are:
     AR_IMAGE_PROC_FRAME_IMAGE
     AR_IMAGE_PROC_FIELD_IMAGE
     The default mode is AR_IMAGE_PROC_FRAME_IMAGE.
     */
    ARController.prototype.setImageProcMode = function(value) {
        return artoolkit.setImageProcMode(this.id, value);
    };

    /**
     Get the image processing mode.

     See arSetImageProcMode() for a complete description.

     @return {number} The current image processing mode.
     */
    ARController.prototype.getImageProcMode = function() {
        return artoolkit.getImageProcMode(this.id);
    };


    /**
     Draw the black and white image and debug markers to the ARController canvas.

     See setDebugMode.
     */
    ARController.prototype.debugDraw = function() {
        var debugBuffer = new Uint8ClampedArray(Module.HEAPU8.buffer, this._bwpointer, this.framesize);
        var id = new ImageData(debugBuffer, this.canvas.width, this.canvas.height)
        this.ctx.putImageData(id, 0, 0)

        var marker_num = this.getMarkerNum();
        for (var i=0; i<marker_num; i++) {
            this._debugMarker(this.getMarker(i));
        }
    };


    // private

    ARController.prototype._initialize = function() {
        this.id = artoolkit.setup(this.canvas.width, this.canvas.height, this.cameraParam.id);

        var params = artoolkit.frameMalloc;
        this.framepointer = params.framepointer;
        this.framesize = params.framesize;

        this.dataHeap = new Uint8Array(Module.HEAPU8.buffer, this.framepointer, this.framesize);

        this.camera_mat = new Float64Array(Module.HEAPU8.buffer, params.camera, 16);
        this.marker_transform_mat = new Float64Array(Module.HEAPU8.buffer, params.transform, 12);

        this.setProjectionNearPlane(0.1)
        this.setProjectionFarPlane(1000);

        var self = this;
        setTimeout(function() {
            if (self.onload) {
                self.onload();
            }
            self.dispatchEvent({
                name: 'load',
                target: self
            });
        }, 1);
    };

    ARController.prototype._copyImageToHeap = function(image) {
        if (!image) {
            image = this.image;
        }


        if (this.orientation === 'portrait') {
            this.ctx.save();
            this.ctx.translate(this.canvas.width, 0);
            this.ctx.rotate(Math.PI/2);
            this.ctx.drawImage(image, 0, 0, this.canvas.height, this.canvas.width); // draw video
            this.ctx.restore();
        } else {
            this.ctx.drawImage(image, 0, 0, this.canvas.width, this.canvas.height); // draw video
        }

        var imageData = this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);
        var data = imageData.data;

        if (this.dataHeap) {
            this.dataHeap.set( data );
            return true;
        }
        return false;
    };

    ARController.prototype._debugMarker = function(marker) {
        var vertex, pos;
        vertex = marker.vertex;
        var ctx = this.ctx;
        ctx.strokeStyle = 'red';

        ctx.beginPath()
        ctx.moveTo(vertex[0][0], vertex[0][1])
        ctx.lineTo(vertex[1][0], vertex[1][1])
        ctx.stroke();

        ctx.beginPath()
        ctx.moveTo(vertex[2][0], vertex[2][1])
        ctx.lineTo(vertex[3][0], vertex[3][1])
        ctx.stroke()

        ctx.strokeStyle = 'green';
        ctx.beginPath()
        ctx.lineTo(vertex[1][0], vertex[1][1])
        ctx.lineTo(vertex[2][0], vertex[2][1])
        ctx.stroke();

        ctx.beginPath()
        ctx.moveTo(vertex[3][0], vertex[3][1])
        ctx.lineTo(vertex[0][0], vertex[0][1])
        ctx.stroke();

        pos = marker.pos
        ctx.beginPath()
        ctx.arc(pos[0], pos[1], 8, 0, Math.PI * 2)
        ctx.fillStyle = 'red'
        ctx.fill()
    };


    // static

    /**
     ARController.getUserMedia gets a device camera video feed and calls the given onSuccess callback with it.

     Tries to start playing the video. Playing the video can fail on Chrome for Android,
     so ARController.getUserMedia adds user input event listeners to the window
     that try to start playing the video. On success, the event listeners are removed.

     To use ARController.getUserMedia, call it with an object with the onSuccess attribute set to a callback function.

     ARController.getUserMedia({
				onSuccess: function(video) {
					console.log("Got video", video);
				}
			});

     The configuration object supports the following attributes:

     {
         onSuccess : function(video),
         onError : function(error),

         width : number | {min: number, ideal: number, max: number},
         height : number | {min: number, ideal: number, max: number},

         facingMode : 'environment' | 'user' | 'left' | 'right' | { exact: 'environment' | ... }
     }

     See https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia for more information about the
     width, height and facingMode attributes.

     @param {object} configuration The configuration object.
     @return {VideoElement} Returns the created video element.
     */
    ARController.getUserMedia = function(configuration) {
        var facing = configuration.facingMode || 'environment';

        var onSuccess = configuration.onSuccess;
        var onError = configuration.onError || function(err) { console.error("ARController.getUserMedia", err); };

        var video = document.createElement('video');

        var initProgress = function() {
            if (this.videoWidth !== 0) {
                onSuccess(video);
            }
        };

        var readyToPlay = false;
        var eventNames = [
            'touchstart', 'touchend', 'touchmove', 'touchcancel',
            'click', 'mousedown', 'mouseup', 'mousemove',
            'keydown', 'keyup', 'keypress', 'scroll'
        ];
        var play = function(ev) {
            if (readyToPlay) {
                video.play();
                if (!video.paused) {
                    eventNames.forEach(function(eventName) {
                        window.removeEventListener(eventName, play, true);
                    });
                }
            }
        };
        eventNames.forEach(function(eventName) {
            window.addEventListener(eventName, play, true);
        });

        var success = function(stream) {
            video.addEventListener('loadedmetadata', initProgress, false);
            video.src = window.URL.createObjectURL(stream);
            readyToPlay = true;
            play(); // Try playing without user input, should work on non-Android Chrome
        };

        var constraints = {};
        var mediaDevicesConstraints = {};
        if (configuration.width) {
            mediaDevicesConstraints.width = configuration.width;
            if (typeof configuration.width === 'object') {
                if (configuration.width.max) {
                    constraints.maxWidth = configuration.width.max;
                }
                if (configuration.width.min) {
                    constraints.minWidth = configuration.width.max;
                }
            } else {
                constraints.maxWidth = configuration.width;
            }
        }

        if (configuration.height) {
            mediaDevicesConstraints.height = configuration.height;
            if (typeof configuration.height === 'object') {
                if (configuration.height.max) {
                    constraints.maxHeight = configuration.height.max;
                }
                if (configuration.height.min) {
                    constraints.minHeight = configuration.height.max;
                }
            } else {
                constraints.maxHeight = configuration.height;
            }
        }

        mediaDevicesConstraints.facingMode = facing;

        navigator.getUserMedia  = navigator.getUserMedia || navigator.webkitGetUserMedia || navigator.mozGetUserMedia || navigator.msGetUserMedia;
        var hdConstraints = {
            audio: false,
            video: {
                mandatory: constraints
            }
        };

        if ( false ) {
            // if ( navigator.mediaDevices || window.MediaStreamTrack) {
            if (navigator.mediaDevices) {
                navigator.mediaDevices.getUserMedia({
                    audio: false,
                    video: mediaDevicesConstraints
                }).then(success, onError);
            } else {
                MediaStreamTrack.getSources(function(sources) {
                    var facingDir = mediaDevicesConstraints.facingMode;
                    if (facing && facing.exact) {
                        facingDir = facing.exact;
                    }
                    for (var i=0; i<sources.length; i++) {
                        if (sources[i].kind === 'video' && sources[i].facing === facingDir) {
                            hdConstraints.video.mandatory.sourceId = sources[i].id;
                            break;
                        }
                    }
                    if (facing && facing.exact && !hdConstraints.video.mandatory.sourceId) {
                        onError('Failed to get camera facing the wanted direction');
                    } else {
                        if (navigator.getUserMedia) {
                            navigator.getUserMedia(hdConstraints, success, onError);
                        } else {
                            onError('navigator.getUserMedia is not supported on your browser');
                        }
                    }
                });
            }
        } else {
            if (navigator.getUserMedia) {
                navigator.getUserMedia(hdConstraints, success, onError);
            } else {
                onError('navigator.getUserMedia is not supported on your browser');
            }
        }

        return video;
    };

    /**
     ARController.getUserMediaARController gets an ARController for the device camera video feed and calls the
     given onSuccess callback with it.

     To use ARController.getUserMediaARController, call it with an object with the cameraParam attribute set to
     a camera parameter file URL, and the onSuccess attribute set to a callback function.

     ARController.getUserMediaARController({
				cameraParam: 'Data/camera_para.dat',
				onSuccess: function(arController, arCameraParam) {
					console.log("Got ARController", arController);
					console.log("Got ARCameraParam", arCameraParam);
					console.log("Got video", arController.image);
				}
			});

     The configuration object supports the following attributes:

     {
         onSuccess : function(ARController, ARCameraParam),
         onError : function(error),

         cameraParam: url, // URL to camera parameters definition file.
         maxARVideoSize: number, // Maximum max(width, height) for the AR processing canvas.

         width : number | {min: number, ideal: number, max: number},
         height : number | {min: number, ideal: number, max: number},

         facingMode : 'environment' | 'user' | 'left' | 'right' | { exact: 'environment' | ... }
     }

     See https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia for more information about the
     width, height and facingMode attributes.

     The orientation attribute of the returned ARController is set to "portrait" if the userMedia video has larger
     height than width. Otherwise it's set to "landscape". The videoWidth and videoHeight attributes of the arController
     are set to be always in landscape configuration so that width is larger than height.

     @param {object} configuration The configuration object.
     @return {VideoElement} Returns the created video element.
     */
    ARController.getUserMediaARController = function(configuration) {
        var obj = {};
        for (var i in configuration) {
            obj[i] = configuration[i];
        }
        var onSuccess = configuration.onSuccess;
        var cameraParamURL = configuration.cameraParam;

        obj.onSuccess = function() {
            new ARCameraParam(cameraParamURL, function() {
                var arCameraParam = this;
                var maxSize = configuration.maxARVideoSize || Math.max(video.videoWidth, video.videoHeight);
                var f = maxSize / Math.max(video.videoWidth, video.videoHeight);
                var w = f * video.videoWidth;
                var h = f * video.videoHeight;
                if (video.videoWidth < video.videoHeight) {
                    var tmp = w;
                    w = h;
                    h = tmp;
                }
                var arController = new ARController(w, h, arCameraParam);
                arController.image = video;
                if (video.videoWidth < video.videoHeight) {
                    arController.orientation = 'portrait';
                    arController.videoWidth = video.videoHeight;
                    arController.videoHeight = video.videoWidth;
                } else {
                    arController.orientation = 'landscape';
                    arController.videoWidth = video.videoWidth;
                    arController.videoHeight = video.videoHeight;
                }
                onSuccess(arController, arCameraParam);
            }, function(err) {
                console.error("ARController: Failed to load ARCameraParam", err);
            });
        };

        var video = this.getUserMedia(obj);
        return video;
    };


    /**
     ARCameraParam is used for loading AR camera parameters for use with ARController.
     Use by passing in an URL and a callback function.

     var camera = new ARCameraParam('Data/camera_para.dat', function() {
				console.log('loaded camera', this.id);
			},
     function(err) {
				console.log('failed to load camera', err);
			});

     @exports ARCameraParam
     @constructor

     @param {string} src URL to load camera parameters from.
     @param {string} onload Onload callback to be called on successful parameter loading.
     @param {string} onerror Error callback to called when things don't work out.
     */
    var ARCameraParam = function(src, onload, onerror) {
        this.id = -1;
        this._src = '';
        this.complete = false;
        this.onload = onload;
        this.onerror = onerror;
        if (src) {
            this.load(src);
        }
    };

    /**
     Loads the given URL as camera parameters definition file into this ARCameraParam.

     Can only be called on an unloaded ARCameraParam instance.

     @param {string} src URL to load.
     */
    ARCameraParam.prototype.load = function(src) {
        if (this._src !== '') {
            throw("ARCameraParam: Trying to load camera parameters twice.")
        }
        this._src = src;
        if (src) {
            var self = this;
            artoolkit.loadCamera(src, function(id) {
                self.id = id;
                self.complete = true;
                self.onload();
            }, function(err) {
                self.onerror(err);
            });
        }
    };

    Object.defineProperty(ARCameraParam.prototype, 'src', {
        set: function(src) {
            this.load(src);
        },
        get: function() {
            return this._src;
        }
    });

    /**
     Destroys the camera parameter and frees associated Emscripten resources.

     */
    ARCameraParam.prototype.dispose = function() {
        if (this.id !== -1) {
            artoolkit.deleteCamera(this.id);
        }
        this.id = -1;
        this._src = '';
        this.complete = false;
    };



    // ARToolKit exported JS API
    //
    var artoolkit = {

        UNKNOWN_MARKER: -1,
        PATTERN_MARKER: 0,
        BARCODE_MARKER: 1,

        loadCamera: loadCamera,

        addMarker: addMarker,
        addMultiMarker: addMultiMarker,

    };

    var FUNCTIONS = [
        'setup',
        'teardown',

        'setLogLevel',
        'getLogLevel',

        'setDebugMode',
        'getDebugMode',

        'getProcessingImage',

        'setMarkerInfoDir',
        'setMarkerInfoVertex',

        'getTransMatSquare',
        'getTransMatSquareCont',

        'getTransMatMultiSquare',
        'getTransMatMultiSquareRobust',

        'getMultiMarkerNum',
        'getMultiMarkerCount',

        'detectMarker',
        'getMarkerNum',

        'getMarker',
        'getMultiEachMarker',

        'setProjectionNearPlane',
        'getProjectionNearPlane',

        'setProjectionFarPlane',
        'getProjectionFarPlane',

        'setThresholdMode',
        'getThresholdMode',

        'setThreshold',
        'getThreshold',

        'setPatternDetectionMode',
        'getPatternDetectionMode',

        'setMatrixCodeType',
        'getMatrixCodeType',

        'setLabelingMode',
        'getLabelingMode',

        'setPattRatio',
        'getPattRatio',

        'setImageProcMode',
        'getImageProcMode',
    ];

    function runWhenLoaded() {
        FUNCTIONS.forEach(function(n) {
            artoolkit[n] = Module[n];
        })

        for (var m in Module) {
            if (m.match(/^AR/))
                artoolkit[m] = Module[m];
        }
    }

    var marker_count = 0;
    function addMarker(arId, url, callback) {
        var filename = '/marker_' + marker_count++;
        ajax(url, filename, function() {
            var id = Module._addMarker(arId, filename);
            if (callback) callback(id);
        });
    }

    function bytesToString(array) {
        return String.fromCharCode.apply(String, array);
    }

    function parseMultiFile(bytes) {
        var str = bytesToString(bytes);

        var lines = str.split('\n');

        var files = [];

        var state = 0; // 0 - read,
        var markers = 0;

        lines.forEach(function(line) {
            line = line.trim();
            if (!line || line.startsWith('#')) return;

            switch (state) {
                case 0:
                    markers = +line;
                    state = 1;
                    return;
                case 1: // filename or barcode
                    if (!line.match(/^\d+$/)) {
                        files.push(line);
                    }
                case 2: // width
                case 3: // matrices
                case 4:
                    state++;
                    return;
                case 5:
                    state = 1;
                    return;
            }
        });

        return files;
    }

    var multi_marker_count = 0;

    function addMultiMarker(arId, url, callback) {
        var filename = '/multi_marker_' + multi_marker_count++;
        ajax(url, filename, function(bytes) {
            var files = parseMultiFile(bytes);

            function ok() {
                var markerID = Module._addMultiMarker(arId, filename);
                var markerNum = Module.getMultiMarkerNum(arId, markerID);
                if (callback) callback(markerID, markerNum);
            }

            if (!files.length) return ok();

            var path = url.split('/').slice(0, -1).join('/')
            files = files.map(function(file) {
                // FIXME super kludge - remove it
                // console.assert(file !== '')
                if( file === 'patt.hiro' || file === 'patt.kanji' || file === 'patt2.hiro' || file === 'patt2.kanji' ){
                    // debugger
                    return ['http://127.0.0.1:8080/data/data/' + file, file]
                }
                return [path + '/' + file, file]
            })
            ajaxDependencies(files, ok);
        });
    }

    var camera_count = 0;
    function loadCamera(url, callback) {
        var filename = '/camera_param_' + camera_count++;
        var writeCallback = function() {
            var id = Module._loadCamera(filename);
            if (callback) callback(id);
        };
        if (typeof url === 'object') { // Maybe it's a byte array
            writeByteArrayToFS(filename, url, writeCallback);
        } else if (url.indexOf("\n") > -1) { // Or a string with the camera param
            writeStringToFS(filename, url, writeCallback);
        } else {
            ajax(url, filename, writeCallback);
        }
    }


    // transfer image

    function writeStringToFS(target, string, callback) {
        var byteArray = new Uint8Array(string.length);
        for (var i=0; i<byteArray.length; i++) {
            byteArray[i] = string.charCodeAt(i) & 0xff;
        }
        writeByteArrayToFS(target, byteArray, callback);
    }

    function writeByteArrayToFS(target, byteArray, callback) {
        FS.writeFile(target, byteArray, { encoding: 'binary' });
        // console.log('FS written', target);

        callback(byteArray);
    }

    // Eg.
    //	ajax('../bin/Data2/markers.dat', '/Data2/markers.dat', callback);
    //	ajax('../bin/Data/patt.hiro', '/patt.hiro', callback);

    function ajax(url, target, callback) {
        var oReq = new XMLHttpRequest();
        oReq.open('GET', url, true);
        oReq.responseType = 'arraybuffer'; // blob arraybuffer

        oReq.onload = function(oEvent) {
            // console.log('ajax done for ', url);
            var arrayBuffer = oReq.response;
            var byteArray = new Uint8Array(arrayBuffer);
            console.log('writeByteArrayToFS', target, byteArray.length, 'byte. url', url)
            writeByteArrayToFS(target, byteArray, callback);
        };

        oReq.send();
    }

    function ajaxDependencies(files, callback) {
        var next = files.pop();
        if (next) {
            ajax(next[0], next[1], function() {
                ajaxDependencies(files, callback);
            });
        } else {
            callback();
        }
    }

    /* Exports */
    window.artoolkit = artoolkit;
    window.ARController = ARController;
    window.ARCameraParam = ARCameraParam;

    if (window.Module) {
        runWhenLoaded();
    } else {
        window.Module = {
            onRuntimeInitialized: function() {
                runWhenLoaded();
            }
        };
    }

})();
var THREEx = THREEx || {}
/**
 * - videoTexture
 * - cloakWidth
 * - cloakHeight
 * - cloakSegmentsHeight
 * - remove all mentions of cache, for cloak
 */
THREEx.ArMarkerCloak = function(videoTexture){
    var updateInShaderEnabled = true

    // build cloakMesh
    // TODO if webgl2 use repeat warp, and not multi segment, this will reduce the geometry to draw
    var geometry = new THREE.PlaneGeometry(1.3+0.25,1.85+0.25, 1, 8).translate(0,-0.3,0)
    var material = new THREE.ShaderMaterial( {
        vertexShader: THREEx.ArMarkerCloak.vertexShader,
        fragmentShader: THREEx.ArMarkerCloak.fragmentShader,
        transparent: true,
        uniforms: {
            texture: {
                value: videoTexture
            },
            opacity: {
                value: 0.5
            }
        },
        defines: {
            updateInShaderEnabled: updateInShaderEnabled ? 1 : 0,
        }
    });

    var cloakMesh = new THREE.Mesh( geometry, material );
    cloakMesh.rotation.x = -Math.PI/2
    this.object3d = cloakMesh

    //////////////////////////////////////////////////////////////////////////////
    //		Code Separator
    //////////////////////////////////////////////////////////////////////////////

    var xMin = -0.65
    var xMax =  0.65
    var yMin =  0.65 + 0.1
    var yMax =  0.95 + 0.1

    //////////////////////////////////////////////////////////////////////////////
    //		originalsFaceVertexUvs
    //////////////////////////////////////////////////////////////////////////////
    var originalsFaceVertexUvs = [[]]

    // build originalsFaceVertexUvs array
    for(var faceIndex = 0; faceIndex < cloakMesh.geometry.faces.length; faceIndex ++ ){
        originalsFaceVertexUvs[0][faceIndex] = []
        originalsFaceVertexUvs[0][faceIndex][0] = new THREE.Vector2()
        originalsFaceVertexUvs[0][faceIndex][1] = new THREE.Vector2()
        originalsFaceVertexUvs[0][faceIndex][2] = new THREE.Vector2()
    }

    // set values in originalsFaceVertexUvs
    for(var i = 0; i < cloakMesh.geometry.parameters.heightSegments/2; i ++ ){
        // one segment height - even row - normale orientation
        originalsFaceVertexUvs[0][i*4+0][0].set( xMin/2+0.5, yMax/2+0.5 )
        originalsFaceVertexUvs[0][i*4+0][1].set( xMin/2+0.5, yMin/2+0.5 )
        originalsFaceVertexUvs[0][i*4+0][2].set( xMax/2+0.5, yMax/2+0.5 )

        originalsFaceVertexUvs[0][i*4+1][0].set( xMin/2+0.5, yMin/2+0.5 )
        originalsFaceVertexUvs[0][i*4+1][1].set( xMax/2+0.5, yMin/2+0.5 )
        originalsFaceVertexUvs[0][i*4+1][2].set( xMax/2+0.5, yMax/2+0.5 )

        // one segment height - odd row - mirror-y orientation
        originalsFaceVertexUvs[0][i*4+2][0].set( xMin/2+0.5, yMin/2+0.5 )
        originalsFaceVertexUvs[0][i*4+2][1].set( xMin/2+0.5, yMax/2+0.5 )
        originalsFaceVertexUvs[0][i*4+2][2].set( xMax/2+0.5, yMin/2+0.5 )

        originalsFaceVertexUvs[0][i*4+3][0].set( xMin/2+0.5, yMax/2+0.5 )
        originalsFaceVertexUvs[0][i*4+3][1].set( xMax/2+0.5, yMax/2+0.5 )
        originalsFaceVertexUvs[0][i*4+3][2].set( xMax/2+0.5, yMin/2+0.5 )
    }

    if( updateInShaderEnabled === true ){
        cloakMesh.geometry.faceVertexUvs = originalsFaceVertexUvs
        cloakMesh.geometry.uvsNeedUpdate = true
    }

    //////////////////////////////////////////////////////////////////////////////
    //		Code Separator
    //////////////////////////////////////////////////////////////////////////////

    var originalOrthoVertices = []
    originalOrthoVertices.push( new THREE.Vector3(xMin, yMax, 0))
    originalOrthoVertices.push( new THREE.Vector3(xMax, yMax, 0))
    originalOrthoVertices.push( new THREE.Vector3(xMin, yMin, 0))
    originalOrthoVertices.push( new THREE.Vector3(xMax, yMin, 0))

    // build debugMesh
    var material = new THREE.MeshNormalMaterial({
        transparent : true,
        opacity: 0.5,
        side: THREE.DoubleSide
    });
    var geometry = new THREE.PlaneGeometry(1,1);
    var orthoMesh = new THREE.Mesh(geometry, material);
    this.orthoMesh = orthoMesh

    //////////////////////////////////////////////////////////////////////////////
    //                Code Separator
    //////////////////////////////////////////////////////////////////////////////

    this.update = function(modelViewMatrix, cameraProjectionMatrix){
        updateOrtho(modelViewMatrix, cameraProjectionMatrix)

        if( updateInShaderEnabled === false ){
            updateUvs(modelViewMatrix, cameraProjectionMatrix)
        }
    }

    return

    // update cloakMesh
    function updateUvs(modelViewMatrix, cameraProjectionMatrix){
        var transformedUv = new THREE.Vector3()
        originalsFaceVertexUvs[0].forEach(function(faceVertexUvs, faceIndex){
            faceVertexUvs.forEach(function(originalUv, uvIndex){
                // set transformedUv - from UV coord to clip coord
                transformedUv.x = originalUv.x * 2.0 - 1.0;
                transformedUv.y = originalUv.y * 2.0 - 1.0;
                transformedUv.z = 0
                // apply modelViewMatrix and projectionMatrix
                transformedUv.applyMatrix4( modelViewMatrix )
                transformedUv.applyMatrix4( cameraProjectionMatrix )
                // apply perspective
                transformedUv.x /= transformedUv.z
                transformedUv.y /= transformedUv.z
                // set back from clip coord to Uv coord
                transformedUv.x = transformedUv.x / 2.0 + 0.5;
                transformedUv.y = transformedUv.y / 2.0 + 0.5;
                // copy the trasnformedUv into the geometry
                cloakMesh.geometry.faceVertexUvs[0][faceIndex][uvIndex].set(transformedUv.x, transformedUv.y)
            })
        })

        // cloakMesh.geometry.faceVertexUvs = faceVertexUvs
        cloakMesh.geometry.uvsNeedUpdate = true
    }

    // update orthoMesh
    function updateOrtho(modelViewMatrix, cameraProjectionMatrix){
        // compute transformedUvs
        var transformedUvs = []
        originalOrthoVertices.forEach(function(originalOrthoVertices, index){
            var transformedUv = originalOrthoVertices.clone()
            // apply modelViewMatrix and projectionMatrix
            transformedUv.applyMatrix4( modelViewMatrix )
            transformedUv.applyMatrix4( cameraProjectionMatrix )
            // apply perspective
            transformedUv.x /= transformedUv.z
            transformedUv.y /= transformedUv.z
            // store it
            transformedUvs.push(transformedUv)
        })

        // change orthoMesh vertices
        for(var i = 0; i < transformedUvs.length; i++){
            orthoMesh.geometry.vertices[i].copy(transformedUvs[i])
        }
        orthoMesh.geometry.computeBoundingSphere()
        orthoMesh.geometry.verticesNeedUpdate = true
    }

}

//////////////////////////////////////////////////////////////////////////////
//                Shaders
//////////////////////////////////////////////////////////////////////////////

THREEx.ArMarkerCloak.markerSpaceShaderFunction = '\n'+
    '        vec2 transformUvToMarkerSpace(vec2 originalUv){\n'+
    '                vec3 transformedUv;\n'+
    '                // set transformedUv - from UV coord to clip coord\n'+
    '                transformedUv.x = originalUv.x * 2.0 - 1.0;\n'+
    '                transformedUv.y = originalUv.y * 2.0 - 1.0;\n'+
    '                transformedUv.z = 0.0;\n'+
    '\n'+
    '		// apply modelViewMatrix and projectionMatrix\n'+
    '                transformedUv = (projectionMatrix * modelViewMatrix * vec4( transformedUv, 1.0 ) ).xyz;\n'+
    '\n'+
    '		// apply perspective\n'+
    '		transformedUv.x /= transformedUv.z;\n'+
    '		transformedUv.y /= transformedUv.z;\n'+
    '\n'+
    '                // set back from clip coord to Uv coord\n'+
    '                transformedUv.x = transformedUv.x / 2.0 + 0.5;\n'+
    '                transformedUv.y = transformedUv.y / 2.0 + 0.5;\n'+
    '\n'+
    '                // return the result\n'+
    '                return transformedUv.xy;\n'+
    '        }'

THREEx.ArMarkerCloak.vertexShader = THREEx.ArMarkerCloak.markerSpaceShaderFunction +
    '	varying vec2 vUv;\n'+
    '\n'+
    '	void main(){\n'+
    '                // pass the UV to the fragment\n'+
    '                #if (updateInShaderEnabled == 1)\n'+
    '		        vUv = transformUvToMarkerSpace(uv);\n'+
    '                #else\n'+
    '		        vUv = uv;\n'+
    '                #endif\n'+
    '\n'+
    '                // compute gl_Position\n'+
    '		vec4 mvPosition = modelViewMatrix * vec4( position, 1.0 );\n'+
    '		gl_Position = projectionMatrix * mvPosition;\n'+
    '	}';

THREEx.ArMarkerCloak.fragmentShader = '\n'+
    '	varying vec2 vUv;\n'+
    '	uniform sampler2D texture;\n'+
    '	uniform float opacity;\n'+
    '\n'+
    '	void main(void){\n'+
    '		vec3 color = texture2D( texture, vUv ).rgb;\n'+
    '\n'+
    '		gl_FragColor = vec4( color, opacity);\n'+
    '	}'
var THREEx = THREEx || {}

THREEx.ArMarkerControls = function(context, object3d, parameters){
    var _this = this
    this.context = context
    // handle default parameters
    this.parameters = {
        // size of the marker in meter
        size : parameters.size !== undefined ? parameters.size : 1,
        // type of marker - ['pattern', 'barcode', 'unknown' ]
        type : parameters.type !== undefined ? parameters.type : 'unknown',
        // url of the pattern - IIF type='pattern'
        patternUrl : parameters.patternUrl !== undefined ? parameters.patternUrl : null,
        // value of the barcode - IIF type='barcode'
        barcodeValue : parameters.barcodeValue !== undefined ? parameters.barcodeValue : null,
        // change matrix mode - [modelViewMatrix, cameraTransformMatrix]
        changeMatrixMode : parameters.changeMatrixMode !== undefined ? parameters.changeMatrixMode : 'modelViewMatrix',
    }

    // sanity check
    var possibleValues = ['pattern', 'barcode', 'multiMarker', 'unknown' ]
    console.assert(possibleValues.indexOf(this.parameters.type) !== -1, 'illegal value', this.parameters.type)
    var possibleValues = ['modelViewMatrix', 'cameraTransformMatrix' ]
    console.assert(possibleValues.indexOf(this.parameters.changeMatrixMode) !== -1, 'illegal value', this.parameters.changeMatrixMode)

    this.markerId = null

    // create the marker Root
    this.object3d = object3d
    this.object3d.matrixAutoUpdate = false;
    this.object3d.visible = false

    // add this marker to artoolkitsystem
    context.addMarker(this)

    // wait for arController to be initialized before going on with the init
    var delayedInitTimerId = setInterval(function(){
        // check if arController is init
        var arController = _this.context.arController
        if( arController === null )	return
        // stop looping if it is init
        clearInterval(delayedInitTimerId)
        delayedInitTimerId = null
        // launch the _postInit
        _this._postInit()
    }, 1000/50)
    return

}

THREEx.ArMarkerControls.prototype._postInit = function(){
    var _this = this
    var markerObject3D = this.object3d;
    // check if arController is init
    var arController = this.context.arController
    console.assert(arController !== null )

    // start tracking this pattern
    if( _this.parameters.type === 'pattern' ){
        arController.loadMarker(_this.parameters.patternUrl, function(markerId) {
            _this.markerId = markerId
            arController.trackPatternMarkerId(_this.markerId, _this.parameters.size);
        });
    }else if( _this.parameters.type === 'barcode' ){
        _this.markerId = _this.parameters.barcodeValue
        arController.trackBarcodeMarkerId(_this.markerId, _this.parameters.size);
    }else if( _this.parameters.type === 'multiMarker' ){
// TODO rename patternUrl into .url - as it is used in multiple parameters
// debugger
        arController.loadMultiMarker(_this.parameters.patternUrl, function(markerId, markerNum) {
            _this.markerId = markerId
            // arController.trackPatternMarkerId(_this.markerId, _this.parameters.size);
        });
        arController.addEventListener('getMultiMarker', function(event) {
            console.log('getMultiMarker')
            if( event.data.multiMarkerId === _this.markerId ){
                onMarkerFound(event)
            }
        });
    }else if( _this.parameters.type === 'unknown' ){
        _this.markerId = null
    }else{
        console.log(false, 'invalid marker type', _this.parameters.type)
    }


    // listen to the event
    arController.addEventListener('getMarker', function(event){

        if( event.data.type === artoolkit.PATTERN_MARKER && _this.parameters.type === 'pattern' ){
            if( _this.markerId === null )	return
            if( event.data.marker.idPatt === _this.markerId ) onMarkerFound(event)
        }else if( event.data.type === artoolkit.BARCODE_MARKER && _this.parameters.type === 'barcode' ){
            // console.log('BARCODE_MARKER idMatrix', event.data.marker.idMatrix, _this.markerId )
            if( _this.markerId === null )	return
            if( event.data.marker.idMatrix === _this.markerId )  onMarkerFound(event)
        }else if( event.data.type === artoolkit.UNKNOWN_MARKER && _this.parameters.type === 'unknown'){
            onMarkerFound(event)
        }
    })

    return
    function onMarkerFound(event){
        // mark object as visible
        markerObject3D.visible = true

        // data.matrix is the model view matrix
        var modelViewMatrix = new THREE.Matrix4().fromArray(event.data.matrix)


        // apply context._axisTransformMatrix - change artoolkit axis to match usual webgl one
        var tmpMatrix = new THREE.Matrix4().copy(_this.context._projectionAxisTransformMatrix)
        tmpMatrix.multiply(modelViewMatrix)

        // change axis orientation on marker - artoolkit say Z is normal to the marker - ar.js say Y is normal to the marker
        var markerAxisTransformMatrix = new THREE.Matrix4().makeRotationX(Math.PI/2)
        tmpMatrix.multiply(markerAxisTransformMatrix)

        modelViewMatrix.copy(tmpMatrix)


        // change markerObject3D.matrix based on parameters.changeMatrixMode
        if( _this.parameters.changeMatrixMode === 'modelViewMatrix' ){
            markerObject3D.matrix.copy(modelViewMatrix)
        }else if( _this.parameters.changeMatrixMode === 'cameraTransformMatrix' ){
            markerObject3D.matrix.getInverse( modelViewMatrix )
        }else {
            console.assert(false)
        }

        // decompose the matrix into .position, .quaternion, .scale
        markerObject3D.matrix.decompose(markerObject3D.position, markerObject3D.quaternion, markerObject3D.scale)

        // dispatchEvent
        _this.dispatchEvent( { type: 'markerFound' } );
    }
}

Object.assign( THREEx.ArMarkerControls.prototype, THREE.EventDispatcher.prototype );

THREEx.ArMarkerControls.prototype.dispose = function(){
    this.context.removeMarker(this)

    // TODO remove the event listener if needed
    // unloadMaker ???
}
var THREEx = THREEx || {}

THREEx.ArToolkitContext = function(parameters){
    var _this = this

    _this._updatedAt = null

    // handle default parameters
    this.parameters = {
        // debug - true if one should display artoolkit debug canvas, false otherwise
        debug: parameters.debug !== undefined ? parameters.debug : false,
        // the mode of detection - ['color', 'color_and_matrix', 'mono', 'mono_and_matrix']
        detectionMode: parameters.detectionMode !== undefined ? parameters.detectionMode : 'color_and_matrix',
        // type of matrix code - valid iif detectionMode end with 'matrix' - [3x3, 3x3_HAMMING63, 3x3_PARITY65, 4x4, 4x4_BCH_13_9_3, 4x4_BCH_13_5_5]
        matrixCodeType: parameters.matrixCodeType !== undefined ? parameters.matrixCodeType : '3x3',

        // url of the camera parameters
        cameraParametersUrl: parameters.cameraParametersUrl !== undefined ? parameters.cameraParametersUrl : THREEx.ArToolkitContext.baseURL + 'parameters/camera_para.dat',

        // tune the maximum rate of pose detection in the source image
        maxDetectionRate: parameters.maxDetectionRate !== undefined ? parameters.maxDetectionRate : 60,
        // resolution of at which we detect pose in the source image
        canvasWidth: parameters.canvasWidth !== undefined ? parameters.canvasWidth : 640,
        canvasHeight: parameters.canvasHeight !== undefined ? parameters.canvasHeight : 480,

        // enable image smoothing or not for canvas copy - default to true
        // https://developer.mozilla.org/en-US/docs/Web/API/CanvasRenderingContext2D/imageSmoothingEnabled
        imageSmoothingEnabled : parameters.imageSmoothingEnabled !== undefined ? parameters.imageSmoothingEnabled : false,
    }

    // set this._projectionAxisTransformMatrix to change artoolkit projection matrix axis to match usual webgl one
    this._projectionAxisTransformMatrix = new THREE.Matrix4()
    this._projectionAxisTransformMatrix.multiply(new THREE.Matrix4().makeRotationY(Math.PI))
    this._projectionAxisTransformMatrix.multiply(new THREE.Matrix4().makeRotationZ(Math.PI))


    this.arController = null;
    this._cameraParameters = null
    this._arMarkersControls = []
}

Object.assign( THREEx.ArToolkitContext.prototype, THREE.EventDispatcher.prototype );

THREEx.ArToolkitContext.baseURL = '../'
// default to github page
// THREEx.ArToolkitContext.baseURL = 'https://raw.githubusercontent.com/jeromeetienne/ar.js/master/three.js/'
THREEx.ArToolkitContext.REVISION = '1.0.1-dev'

/**
 * return the projection matrix
 */
THREEx.ArToolkitContext.prototype.getProjectionMatrix = function(srcElement){
    console.assert(this.arController, 'arController MUST be initialized to call this function')
    // get projectionMatrixArr from artoolkit
    var projectionMatrixArr = this.arController.getCameraMatrix();
    var projectionMatrix = new THREE.Matrix4().fromArray(projectionMatrixArr)

    // apply context._axisTransformMatrix - change artoolkit axis to match usual webgl one
    projectionMatrix.multiply(this._projectionAxisTransformMatrix)

    // return the result
    return projectionMatrix
}

//////////////////////////////////////////////////////////////////////////////
//		Code Separator
//////////////////////////////////////////////////////////////////////////////
THREEx.ArToolkitContext.prototype.init = function(onCompleted){
    var _this = this
    var canvasWidth = this.parameters.canvasWidth
    var canvasHeight = this.parameters.canvasHeight

    // console.log('ArToolkitContext: _onSourceReady width', canvasWidth, 'height', canvasHeight)
    _this._cameraParameters = new ARCameraParam(_this.parameters.cameraParametersUrl, function() {
        // init controller
        var arController = new ARController(canvasWidth, canvasHeight, _this._cameraParameters);
        _this.arController = arController

        arController.ctx.mozImageSmoothingEnabled = _this.parameters.imageSmoothingEnabled;
        arController.ctx.webkitImageSmoothingEnabled = _this.parameters.imageSmoothingEnabled;
        arController.ctx.msImageSmoothingEnabled = _this.parameters.imageSmoothingEnabled;
        arController.ctx.imageSmoothingEnabled = _this.parameters.imageSmoothingEnabled;

        // honor this.parameters.debug
        if( _this.parameters.debug === true ){
            arController.debugSetup();
            arController.canvas.style.position = 'absolute'
            arController.canvas.style.top = '0px'
            arController.canvas.style.opacity = '0.6'
            arController.canvas.style.pointerEvents = 'none'
            arController.canvas.style.zIndex = '-1'
        }

        // setPatternDetectionMode
        var detectionModes = {
            'color'			: artoolkit.AR_TEMPLATE_MATCHING_COLOR,
            'color_and_matrix'	: artoolkit.AR_TEMPLATE_MATCHING_COLOR_AND_MATRIX,
            'mono'			: artoolkit.AR_TEMPLATE_MATCHING_MONO,
            'mono_and_matrix'	: artoolkit.AR_TEMPLATE_MATCHING_MONO_AND_MATRIX,
        }
        var detectionMode = detectionModes[_this.parameters.detectionMode]
        console.assert(detectionMode !== undefined)
        arController.setPatternDetectionMode(detectionMode);

        // setMatrixCodeType
        var matrixCodeTypes = {
            '3x3'		: artoolkit.AR_MATRIX_CODE_3x3,
            '3x3_HAMMING63'	: artoolkit.AR_MATRIX_CODE_3x3_HAMMING63,
            '3x3_PARITY65'	: artoolkit.AR_MATRIX_CODE_3x3_PARITY65,
            '4x4'		: artoolkit.AR_MATRIX_CODE_4x4,
            '4x4_BCH_13_9_3': artoolkit.AR_MATRIX_CODE_4x4_BCH_13_9_3,
            '4x4_BCH_13_5_5': artoolkit.AR_MATRIX_CODE_4x4_BCH_13_5_5,
        }
        var matrixCodeType = matrixCodeTypes[_this.parameters.matrixCodeType]
        console.assert(matrixCodeType !== undefined)
        arController.setMatrixCodeType(matrixCodeType);

        // console.warn('arController fully initialized')

        // notify
        onCompleted && onCompleted()
    })
    return this
}

////////////////////////////////////////////////////////////////////////////////
//          Code Separator
////////////////////////////////////////////////////////////////////////////////
THREEx.ArToolkitContext.prototype.update = function(srcElement){
    // be sure arController is fully initialized
    var arController = this.arController
    if (!arController) return false;

    // honor this.parameters.maxDetectionRate
    var present = performance.now()
    if( this._updatedAt !== null && present - this._updatedAt < 1000/this.parameters.maxDetectionRate ){
        return false
    }
    this._updatedAt = present

    // TODO put this in arToolkitContext
    // var video = arToolkitContext.srcElement
    // if( video.currentTime === lastTime ){
    // 	console.log('skip this frame')
    // 	return
    // }
    // lastTime = video.currentTime

    // if( video.readyState < video.HAVE_CURRENT_DATA ) {
    // 	console.log('skip this frame')
    // 	return
    // }

    // arToolkitContext.srcElement.addEventListener('timeupdate', function(){
    // 	console.log('timeupdate', arguments, Date())
    // })


    // mark all markers to invisible before processing this frame
    this._arMarkersControls.forEach(function(markerControls){
        markerControls.object3d.visible = false
    })

    // process this frame
    arController.process(srcElement)

    // dispatch event
    this.dispatchEvent({
        type: 'sourceProcessed'
    });


    // return true as we processed the frame
    return true;
}


////////////////////////////////////////////////////////////////////////////////
//          Code Separator
////////////////////////////////////////////////////////////////////////////////
THREEx.ArToolkitContext.prototype.addMarker = function(arMarkerControls){
    console.assert(arMarkerControls instanceof THREEx.ArMarkerControls)
    this._arMarkersControls.push(arMarkerControls)
}

THREEx.ArToolkitContext.prototype.removeMarker = function(arMarkerControls){
    console.assert(arMarkerControls instanceof THREEx.ArMarkerControls)
    // console.log('remove marker for', arMarkerControls)
    var index = this.arMarkerControlss.indexOf(artoolkitMarker);
    console.assert(index !== index )
    this._arMarkersControls.splice(index, 1)
}
var THREEx = THREEx || {}

/**
 * ArToolkitProfile helps you build parameters for artoolkit
 * - it is fully independant of the rest of the code
 * - all the other classes are still expecting normal parameters
 * - you can use this class to understand how to tune your specific usecase
 * - it is made to help people to build parameters without understanding all the underlying details.
 */
THREEx.ArToolkitProfile = function(){
    this.reset()

    this.performance('default')
}


THREEx.ArToolkitProfile.prototype._guessPerformanceLabel = function() {
    var isMobile = navigator.userAgent.match(/Android/i)
    || navigator.userAgent.match(/webOS/i)
    || navigator.userAgent.match(/iPhone/i)
    || navigator.userAgent.match(/iPad/i)
    || navigator.userAgent.match(/iPod/i)
    || navigator.userAgent.match(/BlackBerry/i)
    || navigator.userAgent.match(/Windows Phone/i)
        ? true : false
    if( isMobile === true ){
        return 'phone-normal'
    }
    return 'desktop-normal'
}

//////////////////////////////////////////////////////////////////////////////
//		Code Separator
//////////////////////////////////////////////////////////////////////////////

/**
 * reset all parameters
 */
THREEx.ArToolkitProfile.prototype.reset = function () {
    this.sourceParameters = {
        // to read from the webcam
        sourceType : 'webcam',
    }

    this.contextParameters = {
        cameraParametersUrl: THREEx.ArToolkitContext.baseURL + '../data/data/camera_para.dat',
        detectionMode: 'mono',
    }
    this.defaultMarkerParameters = {
        type : 'pattern',
        patternUrl : THREEx.ArToolkitContext.baseURL + '../data/data/patt.hiro'
    }
    return this
};

//////////////////////////////////////////////////////////////////////////////
//		Performance
//////////////////////////////////////////////////////////////////////////////



THREEx.ArToolkitProfile.prototype.performance = function(label) {
    if( label === 'default' ){
        label = this._guessPerformanceLabel()
    }

    if( label === 'desktop-fast' ){
        this.contextParameters.sourceWidth = 640*2
        this.contextParameters.sourceHeight = 480*2

        this.contextParameters.maxDetectionRate = 60
    }else if( label === 'desktop-normal' ){
        this.contextParameters.sourceWidth = 640
        this.contextParameters.sourceHeight = 480

        this.contextParameters.maxDetectionRate = 60
    }else if( label === 'phone-normal' ){
        this.contextParameters.sourceWidth = 80*4
        this.contextParameters.sourceHeight = 60*4

        this.contextParameters.maxDetectionRate = 30
    }else if( label === 'phone-slow' ){
        this.contextParameters.sourceWidth = 80*3
        this.contextParameters.sourceHeight = 60*3

        this.contextParameters.maxDetectionRate = 15
    }else {
        console.assert(false, 'unknonwn label '+label)
    }
}

//////////////////////////////////////////////////////////////////////////////
//		Marker
//////////////////////////////////////////////////////////////////////////////
THREEx.ArToolkitProfile.prototype.kanjiMarker = function () {
    this.contextParameters.detectionMode = 'mono'

    this.defaultMarkerParameters.type = 'pattern'
    this.defaultMarkerParameters.patternUrl = THREEx.ArToolkitContext.baseURL + '../data/data/patt.kanji'
    return this
}

THREEx.ArToolkitProfile.prototype.hiroMarker = function () {
    this.contextParameters.detectionMode = 'mono'

    this.defaultMarkerParameters.type = 'pattern'
    this.defaultMarkerParameters.patternUrl = THREEx.ArToolkitContext.baseURL + '../data/data/patt.hiro'
    return this
}

//////////////////////////////////////////////////////////////////////////////
//		Source
//////////////////////////////////////////////////////////////////////////////
THREEx.ArToolkitProfile.prototype.sourceWebcam = function () {
    this.sourceParameters.sourceType = 'webcam'
    delete this.sourceParameters.sourceUrl
    return this
}


THREEx.ArToolkitProfile.prototype.sourceVideo = function (url) {
    this.sourceParameters.sourceType = 'video'
    this.sourceParameters.sourceUrl = url
    return this
}

THREEx.ArToolkitProfile.prototype.sourceImage = function (url) {
    this.sourceParameters.sourceType = 'image'
    this.sourceParameters.sourceUrl = url
    return this
}
var THREEx = THREEx || {}

THREEx.ArToolkitSource = function(parameters){
    // handle default parameters
    this.parameters = {
        // type of source - ['webcam', 'image', 'video']
        sourceType : parameters.sourceType !== undefined ? parameters.sourceType : 'webcam',
        // url of the source - valid if sourceType = image|video
        sourceUrl : parameters.sourceUrl !== undefined ? parameters.sourceUrl : null,

        // resolution of at which we initialize in the source image
        sourceWidth: parameters.sourceWidth !== undefined ? parameters.sourceWidth : 640,
        sourceHeight: parameters.sourceHeight !== undefined ? parameters.sourceHeight : 480,
        // resolution displayed for the source
        displayWidth: parameters.displayWidth !== undefined ? parameters.displayWidth : 640,
        displayHeight: parameters.displayHeight !== undefined ? parameters.displayHeight : 480,
    }

    this.ready = false
    this.domElement = null
}

//////////////////////////////////////////////////////////////////////////////
//		Code Separator
//////////////////////////////////////////////////////////////////////////////
THREEx.ArToolkitSource.prototype.init = function(onReady){
    var _this = this

    if( this.parameters.sourceType === 'image' ){
        var domElement = this._initSourceImage(onSourceReady)
    }else if( this.parameters.sourceType === 'video' ){
        var domElement = this._initSourceVideo(onSourceReady)
    }else if( this.parameters.sourceType === 'webcam' ){
        var domElement = this._initSourceWebcam(onSourceReady)
    }else{
        console.assert(false)
    }

    // attach
    this.domElement = domElement
    this.domElement.style.position = 'absolute'
    this.domElement.style.top = '0px'
    this.domElement.style.zIndex = '-2'
    this.domElement.style.zIndex = '-2'

    return this
    function onSourceReady(){
        document.body.appendChild(_this.domElement);

        _this.ready = true

        onReady && onReady()
    }
}

////////////////////////////////////////////////////////////////////////////////
//          init image source
////////////////////////////////////////////////////////////////////////////////


THREEx.ArToolkitSource.prototype._initSourceImage = function(onReady) {
    // TODO make it static
    var domElement = document.createElement('img')
    domElement.src = this.parameters.sourceUrl

    domElement.width = this.parameters.sourceWidth
    domElement.height = this.parameters.sourceHeight
    domElement.style.width = this.parameters.displayWidth+'px'
    domElement.style.height = this.parameters.displayHeight+'px'

    // wait until the video stream is ready
    var interval = setInterval(function() {
        if (!domElement.naturalWidth)	return;
        onReady()
        clearInterval(interval)
    }, 1000/50);

    return domElement
}

////////////////////////////////////////////////////////////////////////////////
//          init video source
////////////////////////////////////////////////////////////////////////////////


THREEx.ArToolkitSource.prototype._initSourceVideo = function(onReady) {
    // TODO make it static
    var domElement = document.createElement('video');
    domElement.src = this.parameters.sourceUrl

    domElement.style.objectFit = 'initial'

    domElement.autoplay = true;
    domElement.webkitPlaysinline = true;
    domElement.controls = false;
    domElement.loop = true;
    domElement.muted = true

    // trick to trigger the video on android
    document.body.addEventListener('click', function onClick(){
        document.body.removeEventListener('click', onClick);
        domElement.play()
    })

    domElement.width = this.parameters.sourceWidth
    domElement.height = this.parameters.sourceHeight
    domElement.style.width = this.parameters.displayWidth+'px'
    domElement.style.height = this.parameters.displayHeight+'px'

    // wait until the video stream is ready
    var interval = setInterval(function() {
        if (!domElement.videoWidth)	return;
        onReady()
        clearInterval(interval)
    }, 1000/50);
    return domElement
}

////////////////////////////////////////////////////////////////////////////////
//          handle webcam source
////////////////////////////////////////////////////////////////////////////////


THREEx.ArToolkitSource.prototype._initSourceWebcam = function(onReady) {
    var _this = this
    // TODO make it static
    navigator.getUserMedia  = navigator.getUserMedia || navigator.webkitGetUserMedia || navigator.mozGetUserMedia || navigator.msGetUserMedia;

    var domElement = document.createElement('video');
    domElement.style.width = this.parameters.displayWidth+'px'
    domElement.style.height = this.parameters.displayHeight+'px'


    if (navigator.getUserMedia === undefined ){
        alert("WebRTC issue! navigator.getUserMedia not present in your browser");
    }
    if (navigator.mediaDevices === undefined || navigator.mediaDevices.enumerateDevices === undefined ){
        alert("WebRTC issue! navigator.mediaDevices.enumerateDevices not present in your browser");
    }

    navigator.mediaDevices.enumerateDevices().then(function(devices) {
        // define getUserMedia() constraints
        var constraints = {
            audio: false,
            video: {
                mandatory: {
                    maxWidth: _this.parameters.sourceWidth,
                    maxHeight: _this.parameters.sourceHeight
                }
            }
        }

        devices.forEach(function(device) {
            if( device.kind !== 'videoinput' )	return
            constraints.video.optional = [{sourceId: device.deviceId}]
        });

        // OLD API
        // it it finds the videoSource 'environment', modify constraints.video
        // for (var i = 0; i != sourceInfos.length; ++i) {
        //         var sourceInfo = sourceInfos[i];
        //         if(sourceInfo.kind == "video" && sourceInfo.facing == "environment") {
        //                 constraints.video.optional = [{sourceId: sourceInfo.id}]
        //         }
        // }

        navigator.getUserMedia(constraints, function success(stream) {
            // console.log('success', stream);
            domElement.src = window.URL.createObjectURL(stream);
            // to start the video, when it is possible to start it only on userevent. like in android
            document.body.addEventListener('click', function(){
                domElement.play();
            })
            domElement.play();

            // wait until the video stream is ready
            var interval = setInterval(function() {
                if (!domElement.videoWidth)	return;
                onReady()
                clearInterval(interval)
            }, 1000/50);
        }, function(error) {
            console.log("Can't access user media", error);
            alert("Can't access user media :()");
        });
    }).catch(function(err) {
        console.log(err.name + ": " + err.message);
    });

    return domElement
}

////////////////////////////////////////////////////////////////////////////////
//          handle resize
////////////////////////////////////////////////////////////////////////////////

THREEx.ArToolkitSource.prototype.onResize = function(rendererDomElement){
    var screenWidth = window.innerWidth
    var screenHeight = window.innerHeight

    // compute sourceWidth, sourceHeight
    if( this.domElement.nodeName === "IMG" ){
        var sourceWidth = this.domElement.naturalWidth
        var sourceHeight = this.domElement.naturalHeight
    }else if( this.domElement.nodeName === "VIDEO" ){
        var sourceWidth = this.domElement.videoWidth
        var sourceHeight = this.domElement.videoHeight
    }else{
        console.assert(false)
    }

    // compute sourceAspect
    var sourceAspect = sourceWidth / sourceHeight
    // compute screenAspect
    var screenAspect = screenWidth / screenHeight

    // if screenAspect < sourceAspect, then change the width, else change the height
    if( screenAspect < sourceAspect ){
        // compute newWidth and set .width/.marginLeft
        var newWidth = sourceAspect * screenHeight
        this.domElement.style.width = newWidth+'px'
        this.domElement.style.marginLeft = -(newWidth-screenWidth)/2+'px'

        // init style.height/.marginTop to normal value
        this.domElement.style.height = screenHeight+'px'
        this.domElement.style.marginTop = '0px'
    }else{
        // compute newHeight and set .height/.marginTop
        var newHeight = 1 / (sourceAspect / screenWidth)
        this.domElement.style.height = newHeight+'px'
        this.domElement.style.marginTop = -(newHeight-screenHeight)/2+'px'

        // init style.width/.marginLeft to normal value
        this.domElement.style.width = screenWidth+'px'
        this.domElement.style.marginLeft = '0px'
    }

    if( rendererDomElement !== undefined ){
        // copy arToolkitSource.domElement position to renderer.domElement
        rendererDomElement.style.width = this.domElement.style.width
        rendererDomElement.style.height = this.domElement.style.height
        rendererDomElement.style.marginLeft = this.domElement.style.marginLeft
        rendererDomElement.style.marginTop = this.domElement.style.marginTop
    }
}
var THREEx = THREEx || {}

THREEx.ArVideoInWebgl = function(videoTexture){
    var _this = this

    //////////////////////////////////////////////////////////////////////////////
    //	plane always in front of the camera, exactly as big as the viewport
    //////////////////////////////////////////////////////////////////////////////
    var geometry = new THREE.PlaneGeometry(2, 2);
    var material = new THREE.MeshBasicMaterial({
        // map : new THREE.TextureLoader().load('images/water.jpg'),
        map : videoTexture,
        // side: THREE.DoubleSide,
        // opacity: 0.5,
        // color: 'pink',
        // transparent: true,
    });
    var seethruPlane = new THREE.Mesh(geometry, material);
    this.object3d = seethruPlane
    // scene.add(seethruPlane);

    // arToolkitSource.domElement.style.visibility = 'hidden'

    // TODO extract the fov from the projectionMatrix
    // camera.fov = 43.1
    this.update = function(camera){
        camera.updateMatrixWorld(true)

        // get seethruPlane position
        var position = new THREE.Vector3(-0.15,0,-20)	// TODO how come you got that offset on x ???
        var position = new THREE.Vector3(-0,0,-20)	// TODO how come you got that offset on x ???
        seethruPlane.position.copy(position)
        camera.localToWorld(seethruPlane.position)

        // get seethruPlane quaternion
        camera.matrixWorld.decompose( camera.position, camera.quaternion, camera.scale );
        seethruPlane.quaternion.copy( camera.quaternion )

        // extract the fov from the projectionMatrix
        var fov = THREE.Math.radToDeg(Math.atan(1/camera.projectionMatrix.elements[5])) *2;


        var elementWidth = parseFloat( arToolkitSource.domElement.style.width.replace(/px$/,''), 10 )
        var elementHeight = parseFloat( arToolkitSource.domElement.style.height.replace(/px$/,''), 10 )

        var aspect = elementWidth / elementHeight

        // camera.fov = fov
        // if( vrDisplay.isPresenting ){
        // 	fov *= 2
        // 	aspect *= 2
        // }

        // get seethruPlane height relative to fov
        seethruPlane.scale.y = Math.tan(THREE.Math.DEG2RAD * fov/2)*position.length()
        // get seethruPlane aspect
        seethruPlane.scale.x = seethruPlane.scale.y * aspect
    }

    //////////////////////////////////////////////////////////////////////////////
    //		Code Separator
    //////////////////////////////////////////////////////////////////////////////
    // var video = arToolkitSource.domElement;
    //
    // window.addEventListener('resize', function(){
    // 	updateSeeThruAspectUv(seethruPlane)
    // })
    // video.addEventListener('canplaythrough', function(){
    // 	updateSeeThruAspectUv(seethruPlane)
    // })
    // function updateSeeThruAspectUv(plane){
    //
    // 	// if video isnt yet ready to play
    // 	if( video.videoWidth === 0 || video.videoHeight === 0 )	return
    //
    // 	var faceVertexUvs = plane.geometry.faceVertexUvs[0]
    // 	var screenAspect = window.innerWidth / window.innerHeight
    // 	var videoAspect = video.videoWidth / video.videoHeight
    //
    // 	plane.geometry.uvsNeedUpdate = true
    // 	if( screenAspect >= videoAspect ){
    // 		var actualHeight = videoAspect / screenAspect;
    // 		// faceVertexUvs y 0
    // 		faceVertexUvs[0][1].y = 0.5 - actualHeight/2
    // 		faceVertexUvs[1][0].y = 0.5 - actualHeight/2
    // 		faceVertexUvs[1][1].y = 0.5 - actualHeight/2
    // 		// faceVertexUvs y 1
    // 		faceVertexUvs[0][0].y = 0.5 + actualHeight/2
    // 		faceVertexUvs[0][2].y = 0.5 + actualHeight/2
    // 		faceVertexUvs[1][2].y = 0.5 + actualHeight/2
    // 	}else{
    // 		var actualWidth = screenAspect / videoAspect;
    // 		// faceVertexUvs x 0
    // 		faceVertexUvs[0][0].x = 0.5 - actualWidth/2
    // 		faceVertexUvs[0][1].x = 0.5 - actualWidth/2
    // 		faceVertexUvs[1][0].x = 0.5 - actualWidth/2
    //
    // 		// faceVertexUvs x 1
    // 		faceVertexUvs[0][2].x = 0.5 + actualWidth/2
    // 		faceVertexUvs[1][1].x = 0.5 + actualWidth/2
    // 		faceVertexUvs[1][2].x = 0.5 + actualWidth/2
    // 	}
    // }

}
