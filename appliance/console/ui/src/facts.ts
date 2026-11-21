/**
 * Wombat facts for the claimed screen (CG-08, CG-10): 50 short facts (≤ 160 characters), each checked against the
 * source named with it; myths are left out. The sources stay here and are never shown.
 *
 * Imported from the fact-check of 2026-09-27 (wombat-facts.json).
 */
export interface WombatFact {
  text: string;
  source: string;
  sourceTitle: string;
  confidence: 'high' | 'medium';
}

export const FACTS: readonly WombatFact[] = [
  {
    text: 'The word “wombat” was first written down in 1798, spelled “whom-batt” by 19-year-old John Price near present-day Bargo, NSW.',
    source: 'https://www.paradisec.org.au/blog/2009/01/the-wombat-trail/',
    sourceTitle: 'The ‘wombat’ trail — PARADISEC (David Nash)',
    confidence: 'high',
  },
  {
    text: 'Wombats can run at more than 40 km/h over short distances.',
    source: 'https://australian.museum/learn/animals/mammals/common-wombat/',
    sourceTitle: 'Bare-nosed Wombat — Australian Museum',
    confidence: 'high',
  },
  {
    text: 'Wombats make cube-shaped poo — a bare-nosed wombat typically produces 80 to 100 cubes a day.',
    source: 'https://hu.gatech.edu/wp-content/uploads/2021/01/Hu21-wombat.pdf',
    sourceTitle:
      'Yang et al., “Intestines of non-uniform stiffness mold the corners of wombat feces”, Soft Matter 17 (2021) 475–488',
    confidence: 'high',
  },
  {
    text: 'Koalas are the wombat’s closest living relatives. The two lineages split from a common ancestor in the Oligocene or earlier.',
    source: 'https://australian.museum/learn/australia-over-time/extinct-animals/nimiokoala-greystanesi/',
    sourceTitle: 'Riversleigh Rainforest Koala — Australian Museum',
    confidence: 'high',
  },
  {
    text: 'A wombat mother’s pouch opens backwards, so it doesn’t fill with dirt while she digs.',
    source:
      'https://nre.tas.gov.au/wildlife-management/fauna-of-tasmania/mammals/possums-kangaroos-and-wombats/wombat',
    sourceTitle: 'Bare-nosed Wombat — Department of Natural Resources and Environment Tasmania',
    confidence: 'high',
  },
  {
    text: 'There are three living wombat species: the bare-nosed (or common) wombat, the southern hairy-nosed wombat and the northern hairy-nosed wombat.',
    source: 'https://ielc.libguides.com/sdzg/factsheets/wombats',
    sourceTitle: 'Wombats Fact Sheet — San Diego Zoo Wildlife Alliance Library',
    confidence: 'high',
  },
  {
    text: 'In 1869 the poet Dante Gabriel Rossetti bought a wombat and wrote: “The wombat is a joy, a triumph, a delight, a madness.”',
    source:
      'https://publicdomainreview.org/essay/o-uommibatto-how-the-pre-raphaelites-became-obsessed-with-the-wombat/',
    sourceTitle:
      '“O Uommibatto”: How the Pre-Raphaelites Became Obsessed with the Wombat — The Public Domain Review (Angus Trumble)',
    confidence: 'high',
  },
  {
    text: 'Bare-nosed wombats are among the world’s largest burrowing animals and spend about two-thirds of their lives underground.',
    source: 'https://australian.museum/learn/animals/mammals/common-wombat/',
    sourceTitle: 'Bare-nosed Wombat — Australian Museum',
    confidence: 'high',
  },
  {
    text: 'A newborn southern hairy-nosed wombat joey weighs just 1–2 grams and looks like a pink jellybean.',
    source: 'https://www.australianwildlife.org/animals/southern-hairy-nosed-wombat',
    sourceTitle: 'Southern Hairy-nosed Wombat — Australian Wildlife Conservancy',
    confidence: 'high',
  },
  {
    text: 'Wombat incisors and molars have open roots and keep growing for life — handy when you graze on tough, fibrous grasses.',
    source: 'https://australian.museum/learn/animals/mammals/common-wombat/',
    sourceTitle: 'Bare-nosed Wombat — Australian Museum',
    confidence: 'high',
  },
  {
    text: 'By the early 1980s only about 35 northern hairy-nosed wombats were left. The 2022 census estimated about 400 at Epping Forest National Park.',
    source:
      'https://www.qld.gov.au/environment/plants-animals/conservation/threatened-species/featured-projects/northern-hairy-nosed-wombat',
    sourceTitle: 'Northern hairy-nosed wombat — Queensland Government',
    confidence: 'high',
  },
  {
    text: 'Wombat cubes take shape inside the gut, in roughly the last 17 per cent of the intestine — not at the exit, as people once assumed.',
    source: 'https://phys.org/news/2021-02-wombats-excrete-poop-cubes.html',
    sourceTitle: 'Researchers discover how wombats excrete poop cubes — Phys.org (University of Tasmania)',
    confidence: 'high',
  },
  {
    text: 'Moss seems to be a particular delicacy for wombats, and they can use a front foot to pass food to their mouth.',
    source:
      'https://nre.tas.gov.au/wildlife-management/fauna-of-tasmania/mammals/possums-kangaroos-and-wombats/wombat',
    sourceTitle: 'Bare-nosed Wombat — Department of Natural Resources and Environment Tasmania',
    confidence: 'high',
  },
  {
    text: 'Matthew Flinders spelled it “Whombat” and used the place name “Point Whombat” after a 1798 voyage. Today the spot is called Wombat Point.',
    source: 'https://www.paradisec.org.au/blog/2009/01/the-wombat-trail/',
    sourceTitle: 'The ‘wombat’ trail — PARADISEC (David Nash)',
    confidence: 'high',
  },
  {
    text: 'A mainland bare-nosed wombat averages about a metre long and 26 kg, yet its tail is only about 2.5 cm and hidden by fur.',
    source: 'https://australian.museum/learn/animals/mammals/common-wombat/',
    sourceTitle: 'Bare-nosed Wombat — Australian Museum',
    confidence: 'high',
  },
  {
    text: 'Northern hairy-nosed wombats can sleep up to 18 hours a day.',
    source:
      'https://www.qld.gov.au/environment/plants-animals/conservation/threatened-species/featured-projects/northern-hairy-nosed-wombat',
    sourceTitle: 'Northern hairy-nosed wombat — Queensland Government',
    confidence: 'high',
  },
  {
    text: 'Wombat calls include growls, hisses and a “chikker chikker”. Young wombats make a soft “huh huh”.',
    source: 'https://australian.museum/learn/animals/mammals/common-wombat/',
    sourceTitle: 'Bare-nosed Wombat — Australian Museum',
    confidence: 'high',
  },
  {
    text: 'The biggest northern hairy-nosed wombat burrow ever mapped had more than 90 metres of tunnels and six entrances.',
    source: 'https://www.australianwildlife.org/animals/northern-hairy-nosed-wombat',
    sourceTitle: 'Northern Hairy-nosed Wombat — Australian Wildlife Conservancy',
    confidence: 'high',
  },
  {
    text: 'How to make a cube: parts of the wombat’s intestine wall are stiffer than others, so its contractions press the drying contents into corners.',
    source: 'https://hu.gatech.edu/wp-content/uploads/2021/01/Hu21-wombat.pdf',
    sourceTitle:
      'Yang et al., “Intestines of non-uniform stiffness mold the corners of wombat feces”, Soft Matter 17 (2021) 475–488',
    confidence: 'high',
  },
  {
    text: 'Rossetti named his wombat Top, after his friend William Morris’s nickname, “Topsy”.',
    source:
      'https://publicdomainreview.org/essay/o-uommibatto-how-the-pre-raphaelites-became-obsessed-with-the-wombat/',
    sourceTitle:
      '“O Uommibatto”: How the Pre-Raphaelites Became Obsessed with the Wombat — The Public Domain Review (Angus Trumble)',
    confidence: 'high',
  },
  {
    text: 'A bare-nosed wombat joey spends 6 to 10 months in the pouch, then another 8 to 10 months at its mother’s side.',
    source: 'https://australian.museum/learn/animals/mammals/common-wombat/',
    sourceTitle: 'Bare-nosed Wombat — Australian Museum',
    confidence: 'high',
  },
  {
    text: 'Wombats are energy misers: in the dry season, northern hairy-nosed wombats use only about 40% of the energy expected for a mammal their size.',
    source: 'https://europepmc.org/abstract/MED/12883985',
    sourceTitle:
      'Evans, Green & Newgrain, “The field energetics and water fluxes of free-living wombats”, Oecologia 137 (2003) 171–180',
    confidence: 'high',
  },
  {
    text: 'A 20 km dingo-proof fence went up around Epping Forest in 2002, and northern hairy-nosed wombat numbers have steadily recovered since.',
    source: 'https://www.australianwildlife.org/animals/northern-hairy-nosed-wombat',
    sourceTitle: 'Northern Hairy-nosed Wombat — Australian Wildlife Conservancy',
    confidence: 'high',
  },
  {
    text: 'Wombats rub against logs so often that the wood can become polished over time.',
    source:
      'https://nre.tas.gov.au/wildlife-management/fauna-of-tasmania/mammals/possums-kangaroos-and-wombats/wombat',
    sourceTitle: 'Bare-nosed Wombat — Department of Natural Resources and Environment Tasmania',
    confidence: 'high',
  },
  {
    text: 'Wombats leave their cubes on rocks, logs and small rises to communicate with other wombats. The flat sides may help stop them rolling off.',
    source: 'https://hu.gatech.edu/wp-content/uploads/2021/01/Hu21-wombat.pdf',
    sourceTitle:
      'Yang et al., “Intestines of non-uniform stiffness mold the corners of wombat feces”, Soft Matter 17 (2021) 475–488',
    confidence: 'high',
  },
  {
    text: 'Tasmania’s wombats are their own subspecies, Vombatus ursinus tasmaniensis — about 85 cm long and 20 kg on average, smaller than mainland wombats.',
    source:
      'https://nre.tas.gov.au/wildlife-management/fauna-of-tasmania/mammals/possums-kangaroos-and-wombats/wombat',
    sourceTitle: 'Bare-nosed Wombat — Department of Natural Resources and Environment Tasmania',
    confidence: 'high',
  },
  {
    text: 'Hairy-nosed wombats in semi-arid country can go without drinking. Their dry-season water turnover is among the lowest recorded for any mammal.',
    source: 'https://europepmc.org/abstract/MED/12883985',
    sourceTitle:
      'Evans, Green & Newgrain, “The field energetics and water fluxes of free-living wombats”, Oecologia 137 (2003) 171–180',
    confidence: 'high',
  },
  {
    text: 'An extinct relative, Diprotodon, was the largest marsupial that ever lived, up to 3.8 metres long — and its feet turned inwards, as in wombats.',
    source: 'https://australian.museum/learn/australia-over-time/extinct-animals/diprotodon-optatum/',
    sourceTitle: 'Diprotodon optatum — Australian Museum',
    confidence: 'high',
  },
  {
    text: 'In winter, bare-nosed wombats stay active even above the snowline.',
    source: 'https://australian.museum/learn/animals/mammals/common-wombat/',
    sourceTitle: 'Bare-nosed Wombat — Australian Museum',
    confidence: 'high',
  },
  {
    text: 'Southern hairy-nosed wombats link their burrows into warrens with many entrances, shared by up to 10 wombats.',
    source: 'https://www.australianwildlife.org/animals/southern-hairy-nosed-wombat',
    sourceTitle: 'Southern Hairy-nosed Wombat — Australian Wildlife Conservancy',
    confidence: 'high',
  },
  {
    text: 'The team that worked out how wombats make cube-shaped poo won a 2019 Ig Nobel Prize, for research that makes you laugh, then think.',
    source: 'https://phys.org/news/2021-02-wombats-excrete-poop-cubes.html',
    sourceTitle: 'Researchers discover how wombats excrete poop cubes — Phys.org (University of Tasmania)',
    confidence: 'high',
  },
  {
    text: 'In 2000 the northern hairy-nosed wombat became the first species counted from remotely collected DNA: hairs caught on sticky tape at burrow entrances.',
    source: 'https://theconversation.com/australian-endangered-species-northern-hairy-nosed-wombat-13148',
    sourceTitle: 'Australian endangered species: Northern Hairy-nosed Wombat — The Conversation',
    confidence: 'high',
  },
  {
    text: 'A bare-nosed wombat burrow can be up to 20 metres long and more than 2 metres deep, with several tunnels, entrances and nests.',
    source:
      'https://nre.tas.gov.au/wildlife-management/fauna-of-tasmania/mammals/possums-kangaroos-and-wombats/wombat',
    sourceTitle: 'Bare-nosed Wombat — Department of Natural Resources and Environment Tasmania',
    confidence: 'high',
  },
  {
    text: 'Rossetti often met friends at the wombats’ enclosure at London’s Regent’s Park Zoo. He called the meeting place “the Wombat’s Lair”.',
    source:
      'https://publicdomainreview.org/essay/o-uommibatto-how-the-pre-raphaelites-became-obsessed-with-the-wombat/',
    sourceTitle:
      '“O Uommibatto”: How the Pre-Raphaelites Became Obsessed with the Wombat — The Public Domain Review (Angus Trumble)',
    confidence: 'high',
  },
  {
    text: 'A wombat’s incisors sharpen themselves: hard enamel covers the front, and the softer dentine behind wears faster, keeping a chisel edge.',
    source: 'https://www.australianwildlife.org/animals/northern-hairy-nosed-wombat',
    sourceTitle: 'Northern Hairy-nosed Wombat — Australian Wildlife Conservancy',
    confidence: 'high',
  },
  {
    text: 'After the Black Summer fires, cameras at 28 wombat burrows in NSW caught 30 species inspecting them and 10 going in or out.',
    source:
      'https://wwf.org.au/news/2024/new-study-wombat-burrows-provide-critical-shelter-for-many-species-following/',
    sourceTitle:
      'New study: wombat burrows provide critical shelter for many species following wildfire — WWF-Australia',
    confidence: 'high',
  },
  {
    text: 'The Victorian town of Daylesford was surveyed as “Wombat” in 1854 and renamed in 1855. Wombat Hill still rises on the town’s north-east edge.',
    source: 'https://www.victorianplaces.com.au/daylesford',
    sourceTitle: 'Daylesford — Victorian Places',
    confidence: 'high',
  },
  {
    text: 'Wain, a wombat at Satsukiyama Zoo in Japan, holds the Guinness record for oldest wombat in captivity ever. He was at least 34 in February 2024.',
    source:
      'https://www.guinnessworldrecords.com/news/2024/2/oldest-wombat-ever-wain-is-now-34-years-old-764747',
    sourceTitle: 'Oldest wombat ever, Wain, is now 34 years old — Guinness World Records',
    confidence: 'high',
  },
  {
    text: 'Wain, the oldest wombat ever in a zoo, has a simple secret, says his zoo’s director: “He sleeps when he wants to sleep and eats when he wants to eat.”',
    source:
      'https://www.guinnessworldrecords.com/news/2024/2/oldest-wombat-ever-wain-is-now-34-years-old-764747',
    sourceTitle: 'Oldest wombat ever, Wain, is now 34 years old — Guinness World Records',
    confidence: 'high',
  },
  {
    text: 'Northern hairy-nosed wombats have their second and third hind toes fused into a double claw, used for grooming.',
    source: 'https://www.australianwildlife.org/animals/northern-hairy-nosed-wombat',
    sourceTitle: 'Northern Hairy-nosed Wombat — Australian Wildlife Conservancy',
    confidence: 'high',
  },
  {
    text: 'A wombat’s intestine is 6 to 9 metres long, and food stays inside for 40 to 80 hours — a slow burn that helps it thrive on low-nutrient grasses.',
    source: 'https://hu.gatech.edu/wp-content/uploads/2021/01/Hu21-wombat.pdf',
    sourceTitle:
      'Yang et al., “Intestines of non-uniform stiffness mold the corners of wombat feces”, Soft Matter 17 (2021) 475–488',
    confidence: 'high',
  },
  {
    text: 'Long-term surveys suggest bare-nosed wombat numbers on Tasmania’s main island rose about 61% between 1985 and 2023.',
    source:
      'https://nre.tas.gov.au/wildlife-management/fauna-of-tasmania/mammals/possums-kangaroos-and-wombats/wombat',
    sourceTitle: 'Bare-nosed Wombat — Department of Natural Resources and Environment Tasmania',
    confidence: 'high',
  },
  {
    text: 'The southern hairy-nosed wombat, the smallest of the three species, is South Australia’s state fauna emblem.',
    source: 'https://www.environment.sa.gov.au/goodliving/posts/2018/10/wombat-facts',
    sourceTitle: '10 things you might not know about wombats — Government of South Australia',
    confidence: 'high',
  },
  {
    text: 'Mukupirna, a wombat relative from about 25 million years ago, weighed an estimated 143–171 kg. Its name means “big bones”.',
    source:
      'https://theconversation.com/meet-the-giant-wombat-relative-that-scratched-out-a-living-in-australia-25-million-years-ago-141296',
    sourceTitle:
      'Meet the giant wombat relative that scratched out a living in Australia 25 million years ago — The Conversation',
    confidence: 'high',
  },
  {
    text: 'In 2024 a third northern hairy-nosed wombat colony was founded near St George, Queensland. Up to 60 wombats are to move there over a few years.',
    source: 'https://statements.qld.gov.au/statements/100509',
    sourceTitle:
      'Critically endangered wombats explore new home — Queensland Ministerial Media Statements (6 June 2024)',
    confidence: 'high',
  },
  {
    text: 'Northern hairy-nosed wombat joeys usually stay close to their mothers for about two years.',
    source: 'https://www.australianwildlife.org/animals/northern-hairy-nosed-wombat',
    sourceTitle: 'Northern Hairy-nosed Wombat — Australian Wildlife Conservancy',
    confidence: 'high',
  },
  {
    text: 'When threatened, a wombat can dive into its burrow and block the entrance with its famously tough rump.',
    source:
      'https://www.australiangeographic.com.au/nature-wildlife/2020/11/wombat-bums-theres-more-than-meets-the-eye/',
    sourceTitle: 'Wombat bums: there’s more than meets the eye — Australian Geographic',
    confidence: 'medium',
  },
  {
    text: 'Bare-nosed wombats live up to about 11 years in the wild, and well into their twenties in captivity.',
    source: 'https://australian.museum/learn/animals/mammals/common-wombat/',
    sourceTitle: 'Bare-nosed Wombat — Australian Museum',
    confidence: 'high',
  },
  {
    text: 'Phascolonus gigas, an Ice Age giant wombat, had a skull more than 40 cm long. The SA Museum estimates it weighed up to 250 kg.',
    source: 'https://www.samuseum.sa.gov.au/media/phascolonus-gigas',
    sourceTitle: 'It’s a wombat, but not like you know it… — South Australian Museum',
    confidence: 'medium',
  },
  {
    text: 'On the TV series A Country Practice, the wombat Fatso was played by three wombats: Fatso, George and Garth.',
    source: 'https://www.environment.sa.gov.au/goodliving/posts/2018/10/wombat-facts',
    sourceTitle: '10 things you might not know about wombats — Government of South Australia',
    confidence: 'medium',
  },
];
