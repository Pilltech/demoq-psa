// Texts of the public influencer work-log page (/l/:token), EN + KM. Returned by the API with the link info so the
// page and the API never disagree. Khmer entries marked KM-DRAFT: await the Khmer reviewer (stripped for display).
export const LINK_TEXTS_EN = {
  title: "Log your posts for DemoQ",
  intro: "Add each post you published for this campaign. DemoQ reviews every submission before it counts.",
  deliverable: "Deliverable",
  contractedPosts: "Posts in your agreement",
  postUrl: "Post link",
  postUrlHint: "The public link to your post, starting with https://",
  postedOn: "Date posted",
  metrics: "Results (optional)",
  metricViews: "Views",
  metricLikes: "Likes",
  metricComments: "Comments",
  metricShares: "Shares",
  metricSaves: "Saves",
  metricReach: "Reach",
  proofUrls: "Proof links (up to 5)",
  proofUrlsHint: "Links to screenshots or insights, for example a shared folder.",
  note: "Note for DemoQ (optional)",
  submit: "Submit",
  submitted: "Thank you. Your post is waiting for DemoQ's review.",
  remaining: "Submissions left on this link: {remaining} of {max}",
  expiresOn: "This link works until {date}.",
  yourSubmissions: "Your submissions",
  statusSubmitted: "Waiting for review",
  statusApproved: "Approved",
  statusRejected: "Not accepted",
  privacyNotice:
    "Privacy: DemoQ keeps the links, date and results you send, with your IP address and browser, only to check your work on this campaign. Your details are deleted two years after your last campaign. Do not share this link: anyone who has it can submit in your name.",
} as const;

export type LinkTextKey = keyof typeof LINK_TEXTS_EN;

export const LINK_TEXTS_KM: Record<LinkTextKey, string> = {
  title: "KM-DRAFT: កត់ត្រាការប្រកាសរបស់អ្នកសម្រាប់ DemoQ",
  intro:
    "KM-DRAFT: បញ្ចូលការប្រកាសនីមួយៗដែលអ្នកបានផ្សព្វផ្សាយសម្រាប់យុទ្ធនាការនេះ។ DemoQ ពិនិត្យការដាក់ស្នើនីមួយៗ មុននឹងរាប់បញ្ចូល។",
  deliverable: "KM-DRAFT: ការងារត្រូវប្រគល់",
  contractedPosts: "KM-DRAFT: ចំនួនការប្រកាសតាមកិច្ចព្រមព្រៀង",
  postUrl: "KM-DRAFT: តំណការប្រកាស",
  postUrlHint: "KM-DRAFT: តំណសាធារណៈទៅកាន់ការប្រកាសរបស់អ្នក ដែលចាប់ផ្ដើមដោយ https://",
  postedOn: "KM-DRAFT: កាលបរិច្ឆេទប្រកាស",
  metrics: "KM-DRAFT: លទ្ធផល (មិនចាំបាច់)",
  metricViews: "KM-DRAFT: ចំនួនមើល",
  metricLikes: "KM-DRAFT: ចំនួនចូលចិត្ត",
  metricComments: "KM-DRAFT: មតិយោបល់",
  metricShares: "KM-DRAFT: ការចែករំលែក",
  metricSaves: "KM-DRAFT: ការរក្សាទុក",
  metricReach: "KM-DRAFT: ចំនួនអ្នកឃើញ",
  proofUrls: "KM-DRAFT: តំណភស្តុតាង (អតិបរមា ៥)",
  proofUrlsHint: "KM-DRAFT: តំណទៅរូបថតអេក្រង់ ឬស្ថិតិ ឧទាហរណ៍ថតឯកសាររួម។",
  note: "KM-DRAFT: កំណត់ចំណាំសម្រាប់ DemoQ (មិនចាំបាច់)",
  submit: "KM-DRAFT: ដាក់ស្នើ",
  submitted: "KM-DRAFT: សូមអរគុណ។ ការប្រកាសរបស់អ្នកកំពុងរង់ចាំការពិនិត្យពី DemoQ។",
  remaining: "KM-DRAFT: ចំនួនដាក់ស្នើដែលនៅសល់លើតំណនេះ៖ {remaining} ក្នុងចំណោម {max}",
  expiresOn: "KM-DRAFT: តំណនេះប្រើបានរហូតដល់ {date}។",
  yourSubmissions: "KM-DRAFT: ការដាក់ស្នើរបស់អ្នក",
  statusSubmitted: "KM-DRAFT: កំពុងរង់ចាំការពិនិត្យ",
  statusApproved: "KM-DRAFT: បានអនុម័ត",
  statusRejected: "KM-DRAFT: មិនត្រូវបានទទួលយក",
  privacyNotice:
    "KM-DRAFT: ឯកជនភាព៖ DemoQ រក្សាទុកតំណ កាលបរិច្ឆេទ និងលទ្ធផលដែលអ្នកផ្ញើ រួមជាមួយអាសយដ្ឋាន IP និងកម្មវិធីរុករករបស់អ្នក សម្រាប់តែពិនិត្យការងាររបស់អ្នកក្នុងយុទ្ធនាការនេះប៉ុណ្ណោះ។ ព័ត៌មានរបស់អ្នកនឹងត្រូវលុបចោលពីរឆ្នាំបន្ទាប់ពីយុទ្ធនាការចុងក្រោយរបស់អ្នក។ កុំចែករំលែកតំណនេះ៖ អ្នកណាដែលមានវា អាចដាក់ស្នើក្នុងនាមអ្នកបាន។",
};

/** Both locales, display-ready (the KM-DRAFT marker is stripped). */
export function linkTexts(): Record<"en" | "km", Record<LinkTextKey, string>> {
  const km = Object.fromEntries(Object.entries(LINK_TEXTS_KM).map(([k, v]) => [k, v.replace(/^KM-DRAFT:\s*/, "")])) as Record<
    LinkTextKey,
    string
  >;
  return { en: { ...LINK_TEXTS_EN }, km };
}
