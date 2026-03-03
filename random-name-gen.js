/**
 * Random Nonsense Name Generator
 * Pure client-side JS — no dependencies, no NPM, no Node.
 * Drop into any browser project and call generateName().
 *
 * Example output: "turbo-giraffe-soup-23"
 */

const RandomName = (() => {
  const adjectives = [
    "atomic", "blazing", "cosmic", "dizzy", "elastic", "flimsy", "goofy",
    "hollow", "icy", "jumpy", "kinetic", "lunar", "mushy", "nifty", "orbital",
    "plucky", "quirky", "rusty", "sneaky", "turbo", "ultra", "vivid", "wobbly",
    "zippy", "brainy", "crispy", "dapper", "fizzy", "groovy", "hasty",
    "jolly", "knotty", "lanky", "mighty", "nippy", "oddly", "peppy",
    "radical", "salty", "tangy", "upbeat", "vulgar", "wacky", "zany",
    "chunky", "dusty", "funky", "glitchy", "husky", "itchy", "jazzy",
    "lumpy", "moody", "nerdy", "puffy", "rowdy", "soggy", "toasty"
  ];

  const nouns = [
    "giraffe", "pretzel", "walrus", "cactus", "badger", "waffle", "narwhal",
    "potato", "falcon", "muffin", "yeti", "panda", "squid", "taco", "otter",
    "pickle", "lemur", "donut", "parrot", "turnip", "goblin", "noodle",
    "ferret", "biscuit", "iguana", "mantis", "pelican", "wombat", "clam",
    "dingo", "fungus", "hamster", "jackal", "koala", "moose", "newt",
    "oyster", "puffin", "raven", "sloth", "toucan", "urchin", "viper",
    "weasel", "alpaca", "beetle", "condor", "donkey", "emu", "flamingo"
  ];

  const wildcards = [
    "soup", "cannon", "tornado", "explosion", "circus", "machine", "planet",
    "volcano", "thunder", "blaster", "wizard", "rocket", "pudding", "bonanza",
    "fiesta", "vortex", "capsule", "phantom", "brigade", "rampage",
    "inferno", "avalanche", "odyssey", "factory", "engine", "fortress",
    "dynasty", "eclipse", "mirage", "paradox", "quest", "summit",
    "tempest", "voyage", "zenith", "anthem", "beacon", "cascade",
    "drone", "empire", "fractal", "gambit", "heist", "island",
    "jungle", "kernel", "lagoon", "matrix", "nebula", "opera"
  ];

  function pick(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
  }

  /**
   * Generate a random memorable nonsense name.
   *
   * @param {Object}  [options]
   * @param {string}  [options.separator="-"]    — character between words
   * @param {number}  [options.maxNumber=99]     — upper bound for the suffix number
   * @param {boolean} [options.includeNumber=true] — append a number at the end
   * @returns {string} e.g. "turbo-giraffe-soup-23"
   */
  function generate(options = {}) {
    const sep = options.separator ?? "-";
    const max = options.maxNumber ?? 99;
    const includeNumber = options.includeNumber ?? true;

    const parts = [pick(adjectives), pick(nouns), pick(wildcards)];

    if (includeNumber) {
      parts.push(Math.floor(Math.random() * (max + 1)));
    }

    return parts.join(sep);
  }

  /**
   * Generate an array of unique names.
   *
   * @param {number} count — how many names to generate
   * @param {Object} [options] — same options as generate()
   * @returns {string[]}
   */
  function generateBatch(count, options = {}) {
    const seen = new Set();
    const results = [];
    const maxAttempts = count * 10;
    let attempts = 0;

    while (results.length < count && attempts < maxAttempts) {
      const name = generate(options);
      if (!seen.has(name)) {
        seen.add(name);
        results.push(name);
      }
      attempts++;
    }

    return results;
  }

  return { generate, generateBatch };
})();

// Convenience shortcut
function generateName(options) {
  return RandomName.generate(options);
}
