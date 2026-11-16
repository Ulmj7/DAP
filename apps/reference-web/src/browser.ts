import { copy } from "./copy.js";
import { mountApp } from "./main.js";

document.title = copy.brand;
const root = document.getElementById("app");
if (root === null) throw new Error("#app is missing from index.html");
mountApp(root);
