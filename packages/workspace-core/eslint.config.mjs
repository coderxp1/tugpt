// Thin re-export so `eslint .` resolves correctly when Turbo runs this
// package's `lint` script with this directory as the working directory.
// The actual rules live in the shared root config — do not duplicate them
// here.
import rootConfig from '../../eslint.config.mjs';

export default rootConfig;
