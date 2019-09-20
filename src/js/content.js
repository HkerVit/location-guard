//
// content.js
//
// This script runs as a _content script_ (in a separate js environment) on all pages.
//
// HOWEVER:
// Chrome does not allow content scripts in internal pages, so in the _demo page_ we just
// include content.js as a normal <script>. This mostly works (we don't need the
// separate js environment anyway), apart from a few things marked as DEMO below.
//
//
// PostRPC is being used for communication between the content script and the code
// injected in the page (they both share the same window object).
// NOTE: this communication is not secure and could be intercepted by the page.
//       so only a noisy location should be transmitted over PostRPC
//
// The following run in the content script

const Browser = require('./browser');
const Util = require('./util').Util;
const PostRPC = require('./util').PostRPC;
const injectedCode = require('./injected');

// insert a script in the html, inline (<script>...</script>) or external (<script src='...'>)
function insertScript(inline, data) {
	var script = document.createElement('script');
	script.setAttribute('id', '__lg_script');
	if(inline)
		script.appendChild(document.createTextNode(data));
	else
		script.setAttribute('src', data);

	// FF: there is another variables in the scope named parent, this causes a very hard to catch bug
	var _parent = document.head || document.body || document.documentElement;
	var firstChild = (_parent.childNodes && (_parent.childNodes.length > 0)) ? _parent.childNodes[0] : null;
	if(firstChild)
		_parent.insertBefore(script, firstChild);
	else
		_parent.appendChild(script);
}

// DEMO: save the getCurrentPosition function, cause in the demo page it gets replaced (no separate js environment)
var getCurrentPosition = navigator.geolocation.getCurrentPosition;

if(Browser.inDemo) {	// DEMO: this is set in demo.js
	// DEMO: we are inside the page, just run injectedCode()
	injectedCode(PostRPC);

} else if(document.documentElement.tagName.toLowerCase() == 'html') { // only for html
	// We first try to inject the code in an inline <script>. This is the only way to force it to run immediately.
	// We inject PostRPC/injectedCode, and call injectedCode, all protected by an anonymous function.
	//
	var code = "(function(){" +
		"var PostRPC; " + require('./util')._PostRPC + injectedCode +
		"_PostRPC(); injectedCode(PostRPC);" +
	"})()";
	insertScript(true, code);

	// BUT: in Firefox this fails if the page has a CSP that prevents inline scripts (chrome ignores the CSP for scripts injected by extensions).
	// If the inline script did not execute, we insert an external one (this might be executed too late, but it's all we can do).
	//
	var s = document.getElementById('__lg_script');
	if(s) { // the injected code deletes the script, if it's still there it means that the code failed
		s.remove();
		insertScript(false, Browser.gui.getURL("js/inject.js"));
	}
}

var inFrame = (window != window.top);	// are we in a frame?
var apiCalls = 0;						// how many times the API has been called here or in an iframe
var myUrl = Browser.inDemo ? 'http://demo-page/' : window.location.href;	// DEMO: user-friendly url
var callUrl = myUrl;					// the url from which the last call is _shown_ to be made (it could be a nested frame if the last call was made there and Browser.capabilities.iframeGeoFromOwnDomain() is true)

// methods called by the page
//
var rpc = new PostRPC('page-content', window, window, window.origin);
rpc.register('getNoisyPosition', function(options, replyHandler) {
	if(inFrame) {
		// we're in a frame, we need to notify the top window, and get back the *url used in the permission dialog*
		// (which might be either the iframe url, or the top window url, depending on how the browser handles permissions).
		// To avoid cross-origin issues, we call apiCalledInFrame in the main script, which echoes the
		// call back to this tab to be answered by the top window
		Browser.rpc.call(null, 'apiCalledInFrame', [myUrl], function(topUrl) {
			callUrl = Browser.capabilities.iframeGeoFromOwnDomain() ? myUrl : topUrl;
			getNoisyPosition(options, replyHandler);
		});

	} else {
		// refresh icon before fetching the location
		apiCalls++;
		callUrl = myUrl;	// last call happened here
		Browser.gui.refreshIcon('self');
		getNoisyPosition(options, replyHandler);
	}

	return true;	// will reply later
});

// gets the options passed to the fake navigator.geolocation.getCurrentPosition.
// Either returns fixed pos directly, or calls the real one, then calls addNoise.
//
function getNoisyPosition(options, replyHandler) {
	Browser.storage.get(function(st) {
		// if level == 'fixed' and fixedPosNoAPI == true, then we return the
		// fixed position without calling the geolocation API at all.
		//
		var domain = Util.extractDomain(callUrl);
		var level = st.domainLevel[domain] || st.defaultLevel;

		if(!st.paused && level == 'fixed' && st.fixedPosNoAPI) {
			var noisy = {
				coords: {
					latitude: st.fixedPos.latitude,
					longitude: st.fixedPos.longitude,
					accuracy: 10,
					altitude: null,
					altitudeAccuracy: null,
					heading: null,
					speed: null
				},
				timestamp: new Date().getTime()
			};
			replyHandler(true, noisy);
			Browser.log("returning fixed", noisy);
			return;
		}

		// we call getCurrentPosition here in the content script, instead of
		// inside the page, because the content-script/page communication is not secure
		//
		getCurrentPosition.apply(navigator.geolocation, [
			function(position) {
				// clone, modifying/sending the native object returns error
				addNoise(Util.clone(position), function(noisy) {
					replyHandler(true, noisy);
				});
			},
			function(error) {
				replyHandler(false, Util.clone(error));		// clone, sending the native object returns error
			},
			options
		]);
	});
}

// gets position, returs noisy version based on the privacy options
//
function addNoise(position, handler) {
	Browser.storage.get(function(st) {
		var domain = Util.extractDomain(callUrl);
		var level = st.domainLevel[domain] || st.defaultLevel;

		if(st.paused || level == 'real') {
			// do nothing, use real location

		} else if(level == 'fixed') {
			position.coords = {
				latitude: st.fixedPos.latitude,
				longitude: st.fixedPos.longitude,
				accuracy: 10,
				altitude: null,
				altitudeAccuracy: null,
				heading: null,
				speed: null
			};

		} else if(st.cachedPos[level] && ((new Date).getTime() - st.cachedPos[level].epoch)/60000 < st.levels[level].cacheTime) {
			position = st.cachedPos[level].position;
			Browser.log('using cached', position);

		} else {
			// add noise
			var epsilon = st.epsilon / st.levels[level].radius;

			const PlanarLaplace = require('./laplace');
			var pl = new PlanarLaplace();
			var noisy = pl.addNoise(epsilon, position.coords);

			position.coords.latitude = noisy.latitude;
			position.coords.longitude = noisy.longitude;

			// update accuracy
			if(position.coords.accuracy && st.updateAccuracy)
				position.coords.accuracy += Math.round(pl.alphaDeltaAccuracy(epsilon, .9));

			// don't know how to add noise to those, so we set to null (they're most likely null anyway)
			position.altitude = null;
			position.altitudeAccuracy = null;
			position.heading = null;
			position.speed = null;

			// cache
			st.cachedPos[level] = { epoch: (new Date).getTime(), position: position };
			Browser.storage.set(st);

			Browser.log('noisy coords', position.coords);
		}

		// return noisy position
		handler(position);
	});
}

Browser.init('content');

// if a browser action (always visible button) is used, we need to refresh the
// icon immediately (before the API is called). HOWEVER: Browser.gui.refreshIcon
// causes the background script to be awaken. To avoid doing this on every page,
// we only call it if the icon is different than the default icon!
//
if(Browser.capabilities.permanentIcon() && !inFrame) {
	Util.getIconInfo({ callUrl: myUrl, apiCalls: 0 }, function(info) {
		if(info.private != info.defaultPrivate) // the icon for myUrl is different than the default
			Browser.gui.refreshIcon('self');
	})
}

// only the top frame handles getState and apiCalledInFrame requests
if(!inFrame) {
	Browser.rpc.register('getState', function(tabId, replyHandler) {
		replyHandler({
			callUrl: callUrl,
			apiCalls: apiCalls
		});
	});

	Browser.rpc.register('apiCalledInFrame', function(iframeUrl, tabId, replyHandler) {
		apiCalls++;
		if(Browser.capabilities.iframeGeoFromOwnDomain())
			callUrl = iframeUrl;
		Browser.gui.refreshIcon('self');

		replyHandler(myUrl);
	});
}

if(Browser.testing) {
	// test for nested calls, and for correct passing of tabId
	//
	Browser.rpc.register('nestedTestTab', function(tabId, replyHandler) {
		Browser.log("in nestedTestTab, returning 'content'");
		replyHandler("content");
	});

	Browser.log("calling nestedTestMain");
	Browser.rpc.call(null, 'nestedTestMain', [], function(res) {
		Browser.log('got from nestedTestMain', res);
	});
}
