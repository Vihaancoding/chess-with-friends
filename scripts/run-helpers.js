// The helper itself lives in public/helpers/run-helpers.js, so the site can serve it to the Windows download
// (public/helpers/chess-helpers.bat, linked from the Admin panel). This keeps `node scripts/run-helpers.js` working.
require('../public/helpers/run-helpers.js');
