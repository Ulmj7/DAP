import { mountApp } from "./main.js";

const root = document.getElementById("app");
if (root === null) throw new Error("#app is missing from index.html");
mountApp(root);
