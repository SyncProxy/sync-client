(function() {

    'use strict';

    var options = {
        prependTo: document.body.childNodes[0],
        lifeSpan: 4000,
        position: 'top-right',
        animate: false,
        animateDuration: 0
    };

    var classes = {
        container: 'toast-container',
        animate: 'toast-exit',
        default: 'toast',
        success: 'toast-success',
        info: 'toast-info',
        warning: 'toast-warn',
        error: 'toast-error'
    };

    var toastada = {

        setOptions: setOptions,

        setClasses: setClasses,

        success: function(msg) {
            placeToast(msg, 'success');
        },

        info: function(msg) {
            placeToast(msg, 'info');
        },

        warning: function(msg) {
            placeToast(msg, 'warning');
        },

        error: function(msg) {
            placeToast(msg, 'error');
        }

    };

    function setOptions(opts) {

        for (var key in opts) {
            if (opts.hasOwnProperty(key)) {
                if (key in options) {
                    options[key] = opts[key];
                }
            }
        }

    }

    function setClasses(classDict) {

        for (var key in classDict) {
            if (classDict.hasOwnProperty(key)) {
                if (key in classes) {
                    classes[key] = classDict[key];
                }
            }
        }

    }

    function placeToast(html, toastType) {

        var toastContainer = document.querySelector('.' + classes.container);

        var containerExists = !!toastContainer;

        if (!toastContainer) {
            toastContainer = document.createElement('div');
            toastContainer.className = classes.container;
        }

        var newToast = document.createElement('div');
        newToast.className = classes.default + ' ' + classes[toastType];

        newToast.innerHTML = html;

        if (!containerExists) {

            // Set toast container position
            switch(options.position) {

                case 'top-right':
                    toastContainer.style.top = '10px';
                    toastContainer.style.right = '10px';
                    break;

                // case 'top-left':
                //     toastContainer.style.top = '10px';
                //     toastContainer.style.left = '10px';
                //     break;
                //
                // case 'bottom-left':
                //     toastContainer.style.bottom = '10px';
                //     toastContainer.style.left = '10px';
                //     break;
                //
                // case 'bottom-right':
                //     toastContainer.style.bottom = '10px';
                //     toastContainer.style.right = '10px';
                //     break;

                default:
                    toastContainer.style.top = '10px';
                    toastContainer.style.right = '10px';
            }

            document.body.insertBefore(toastContainer, options.prependTo);

        }

        toastContainer.insertBefore(newToast, toastContainer.childNodes[0]);

        // This timeout is used for the duration that the
        // toast will stay on the page
        setTimeout(function() {

            // Animation is set to perform
            if (options.animate && options.animateDuration) {

                newToast.classList.add(classes.animate);

                // This timeout is used to defer the reomval of the
                // toast from the dom for `options.animateDuration`
                // milliseconds
                setTimeout(function() {

                    newToast.remove();

                    var numToasts = document.querySelector('.' + classes.container).childNodes.length;

                    if (!numToasts) {
                        toastContainer.remove();
                    }

                }, options.animateDuration);

            } else {

                newToast.remove();

                var numToasts = document.querySelector('.' + classes.container).childNodes.length;

                if (!numToasts) {
                    toastContainer.remove();
                }

            }

        }, options.lifeSpan);

    }

    window.toastada = toastada;

})();
