import { KINDLE_SENDS_PER_DAY } from './limit'

/**
 * The words of lastten.org/kindle (issue #117): how a parent sets up Send to Kindle. Data, not
 * JSX, so a test can hold the page to its promises - above all that it names our sending
 * address exactly as the server sends from it, and never invents one.
 *
 * Amazon's side is described by the names on Amazon's own pages. They are Amazon's to rename;
 * if they do, this file is the one place to change.
 */

/** Where a parent ends up on this site. */
export const KINDLE_HELP_PATH = '/kindle'

/** Amazon's pages. Links only: the page loads nothing from Amazon. */
export const AMAZON = {
  /**
   * Manage Your Content and Devices → Preferences, where Personal Document Settings lives.
   * The `settings/payment` ending is Amazon's real address for the Preferences tab, not a slip.
   */
  preferences: 'https://www.amazon.com/hz/mycd/myx#/home/settings/payment',
  /** Amazon's own help for sending documents by email. */
  help: 'https://www.amazon.com/sendtokindle/email',
} as const

export interface KindleHelpStep {
  id: 'find-address' | 'approve-sender' | 'save-address' | 'send-book'
  title: string
  body: readonly string[]
}

/**
 * The four steps, in the order a parent does them. `fromAddress` is the address the server
 * sends from (`kindleFromAddress()`); the approve-sender step is the only one that needs it.
 */
export function kindleHelpSteps(fromAddress: string): readonly KindleHelpStep[] {
  return [
    {
      id: 'find-address',
      title: "Find your Kindle's email address",
      body: [
        'Every Kindle has its own address ending in @kindle.com. On Amazon, open Manage Your Content and Devices, choose Preferences, then scroll to Personal Document Settings. The address is listed under Send-to-Kindle E-Mail Settings, one for each Kindle and Kindle app.',
        'On the Kindle itself it is under Settings, Your Account, Send-to-Kindle Email.',
        "Use the Amazon site your Kindle is registered with. The links here open amazon.com; if yours is another country's, such as amazon.co.uk, sign in there and follow the same menus.",
      ],
    },
    {
      id: 'approve-sender',
      title: 'Tell Amazon to accept books from us',
      body: [
        `In the same Personal Document Settings, find Approved Personal Document E-mail List and choose Add a new approved e-mail address. Enter ${fromAddress} exactly as written here and choose Add Address.`,
        'Amazon throws away anything sent from an address that is not on this list, without telling you or us. This is the step that is most often missed.',
      ],
    },
    {
      id: 'save-address',
      title: 'Give us your Kindle address',
      body: [
        'Open Settings here, type the @kindle.com address from step 1 under Kindle, and save it. It is used only to send a book you ask for.',
      ],
    },
    {
      id: 'send-book',
      title: 'Send a book',
      body: [
        "Open any book, tonight's or an old one from your library, and choose Send to Kindle at the end of the book. A saved book has the same button in its menu. It usually arrives within a few minutes, while the Kindle is on Wi-Fi.",
        `Books are sent one at a time, when you ask. Nothing is sent on its own, and you can send up to ${KINDLE_SENDS_PER_DAY} a day.`,
      ],
    },
  ]
}

/** When the book has not arrived. Each line stands on its own. */
export function kindleHelpTroubles(fromAddress: string): readonly string[] {
  return [
    `Check the approved list has ${fromAddress}, spelled exactly. One wrong letter and Amazon drops the book silently.`,
    'Check the address saved in Settings is the one for the Kindle you are holding. Each Kindle and Kindle app has its own.',
    'Amazon sometimes emails the address on your Amazon account asking you to verify the request. Approve it within 48 hours and the book is delivered.',
    'Put the Kindle on Wi-Fi and choose Sync from its menu. A book can take a few minutes.',
  ]
}

/** Said instead of the steps when this server has no mail set up. */
export const KINDLE_HELP_OFF =
  'Send to Kindle is not switched on here yet. When it is, this page will show the address to add on Amazon.'
