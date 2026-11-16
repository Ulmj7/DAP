/** The app's English copy. Semantic identifiers and data never become UI messages. */
export const copy = {
 semantic: {
  "nav.settings": { label: "Settings link", description: "Opens the settings page" },
  "nav.profile": { label: "Profile link", description: "Opens the profile page" },
  "profile.nameInput": { label: "Name", description: "Your display name" },
  "profile.emailInput": { label: "Email", description: "Your email address" },
  "profile.saveButton": { label: "Save", description: "Saves your profile" },
  "settings.advancedToggle": { label: "Advanced", description: "Shows or hides the advanced settings" },
  "settings.securityPanel": { label: "Security", description: "The security settings section" },
  "settings.twoFactorSetup": { label: "Two-factor setup", description: "Starts two-factor authentication setup" },
 },
 guide: { link: "Guides", start: "Start guide", active: "Guide in progress", refused: "A guide cannot start right now. Finish or cancel the current guide, then try again.", cancel: "Cancel", ack: "Got it", escape: "Esc to cancel", retry: "Retry", step: "Step", of: "of", click: "Click the highlighted control.", input: "Type in the highlighted field.", route: "Open the requested page.", checking: "Checking…", saving: "Saving and checking…" },
 result: { completed: "Guide completed", cancelled: "Guide cancelled", blocked: "Let’s try that again", unavailable: "Guide temporarily unavailable", cancelledText: "You stopped this guide. You can start it again whenever you are ready.", blockedText: "That step could not be verified. You can restart the guide and try again.", unavailableText: "This guide cannot continue right now. Please try again later.", done: "Done", close: "Close", retry: "Try again" },
 titles: { dashboard: "DAP — Dashboard", profile: "DAP — Profile", settings: "DAP — Settings" },
 brand: "DAP", navigation: "Main navigation", nav: { dashboard: "Dashboard", profile: "Profile", settings: "Settings" },
 dashboard: { title: "Dashboard", intro: "A little space to make yourself at home.", profile: "Make it yours", profileText: "Update your display name and review your profile details.", profileLink: "Open Profile", settings: "Your settings, together", settingsText: "Find security options and explore the demo controls.", settingsLink: "Open Settings", guides: "Guides", guidesText: "Choose a guided tour of this demo." },
 profile: { title: "Profile", intro: "The details that make this space yours.", section: "Personal details", name: "Display name", hint: "Use between 2 and 80 characters. Spaces at either end are removed on save.", email: "Email", phone: "Phone", password: "Password", save: "Save", savingButton: "Saving…", ready: "Your changes stay in this demo.", dirty: "You have unsaved changes.", validation: "Check your display name before saving.", too_short: "Enter at least 2 characters.", too_long: "Use no more than 80 characters.", saving: "Saving your profile…", saved: "Your profile was saved.", failed: "We could not save your profile. Please try again.", billing: "Billing notes", billingText: "Private to this device. The guidance layer never sees this panel.", billingLabel: "Billing note", },
 settings: { title: "Settings", intro: "Keep your preferences in one place.", security: "Security", securityText: "Review how your account is protected.", advanced: "Advanced", twoFactor: "Set up two-factor authentication", demoNote: "Demo control: nothing changes." },
} as const;
