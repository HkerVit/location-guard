// This is loaded as an external script if the inline <script>...</script> is prevented by a CSP.
// It simply runs the injectedCode function.
//
const PostRPC = require('./util').PostRPC;
const injectedCode = require('./injected');

injectedCode(PostRPC);