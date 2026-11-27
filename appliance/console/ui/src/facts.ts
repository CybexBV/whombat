/**
 * Wombat facts for the claimed screen (CG-08, CG-10): 50 short facts (≤ 160 characters), each checked against the
 * source named with it; myths are left out. The sources stay here and are never shown.
 *
 * Imported from the fact-check of 2026-09-27 (wombat-facts.json).
 */
import { EN, type FactKey } from './i18n/catalog';
export interface WombatFact {
  key: FactKey;
  text: string;
  source: string;
  sourceTitle: string;
  confidence: 'high' | 'medium';
}

export const FACTS: readonly WombatFact[] = [
  {
    key: 'fact.theWordWombatWasFirstWrittenDown',
    text: EN['fact.theWordWombatWasFirstWrittenDown'],
    source: 'https://www.paradisec.org.au/blog/2009/01/the-wombat-trail/',
    sourceTitle: 'The ‘wombat’ trail — PARADISEC (David Nash)',
    confidence: 'high',
  },
  {
    key: 'fact.wombatsCanRunAtMoreThanKm',
    text: EN['fact.wombatsCanRunAtMoreThanKm'],
    source: 'https://australian.museum/learn/animals/mammals/common-wombat/',
    sourceTitle: 'Bare-nosed Wombat — Australian Museum',
    confidence: 'high',
  },
  {
    key: 'fact.wombatsMakeCubeShapedPooABare',
    text: EN['fact.wombatsMakeCubeShapedPooABare'],
    source: 'https://hu.gatech.edu/wp-content/uploads/2021/01/Hu21-wombat.pdf',
    sourceTitle:
      'Yang et al., “Intestines of non-uniform stiffness mold the corners of wombat feces”, Soft Matter 17 (2021) 475–488',
    confidence: 'high',
  },
  {
    key: 'fact.koalasAreTheWombatsClosestLivingRelatives',
    text: EN['fact.koalasAreTheWombatsClosestLivingRelatives'],
    source: 'https://australian.museum/learn/australia-over-time/extinct-animals/nimiokoala-greystanesi/',
    sourceTitle: 'Riversleigh Rainforest Koala — Australian Museum',
    confidence: 'high',
  },
  {
    key: 'fact.aWombatMothersPouchOpensBackwardsSo',
    text: EN['fact.aWombatMothersPouchOpensBackwardsSo'],
    source:
      'https://nre.tas.gov.au/wildlife-management/fauna-of-tasmania/mammals/possums-kangaroos-and-wombats/wombat',
    sourceTitle: 'Bare-nosed Wombat — Department of Natural Resources and Environment Tasmania',
    confidence: 'high',
  },
  {
    key: 'fact.thereAreThreeLivingWombatSpeciesThe',
    text: EN['fact.thereAreThreeLivingWombatSpeciesThe'],
    source: 'https://ielc.libguides.com/sdzg/factsheets/wombats',
    sourceTitle: 'Wombats Fact Sheet — San Diego Zoo Wildlife Alliance Library',
    confidence: 'high',
  },
  {
    key: 'fact.inThePoetDanteGabrielRossettiBought',
    text: EN['fact.inThePoetDanteGabrielRossettiBought'],
    source:
      'https://publicdomainreview.org/essay/o-uommibatto-how-the-pre-raphaelites-became-obsessed-with-the-wombat/',
    sourceTitle:
      '“O Uommibatto”: How the Pre-Raphaelites Became Obsessed with the Wombat — The Public Domain Review (Angus Trumble)',
    confidence: 'high',
  },
  {
    key: 'fact.bareNosedWombatsAreAmongTheWorlds',
    text: EN['fact.bareNosedWombatsAreAmongTheWorlds'],
    source: 'https://australian.museum/learn/animals/mammals/common-wombat/',
    sourceTitle: 'Bare-nosed Wombat — Australian Museum',
    confidence: 'high',
  },
  {
    key: 'fact.aNewbornSouthernHairyNosedWombatJoey',
    text: EN['fact.aNewbornSouthernHairyNosedWombatJoey'],
    source: 'https://www.australianwildlife.org/animals/southern-hairy-nosed-wombat',
    sourceTitle: 'Southern Hairy-nosed Wombat — Australian Wildlife Conservancy',
    confidence: 'high',
  },
  {
    key: 'fact.wombatIncisorsAndMolarsHaveOpenRoots',
    text: EN['fact.wombatIncisorsAndMolarsHaveOpenRoots'],
    source: 'https://australian.museum/learn/animals/mammals/common-wombat/',
    sourceTitle: 'Bare-nosed Wombat — Australian Museum',
    confidence: 'high',
  },
  {
    key: 'fact.byTheEarlySOnlyAboutNorthern',
    text: EN['fact.byTheEarlySOnlyAboutNorthern'],
    source:
      'https://www.qld.gov.au/environment/plants-animals/conservation/threatened-species/featured-projects/northern-hairy-nosed-wombat',
    sourceTitle: 'Northern hairy-nosed wombat — Queensland Government',
    confidence: 'high',
  },
  {
    key: 'fact.wombatCubesTakeShapeInsideTheGut',
    text: EN['fact.wombatCubesTakeShapeInsideTheGut'],
    source: 'https://phys.org/news/2021-02-wombats-excrete-poop-cubes.html',
    sourceTitle: 'Researchers discover how wombats excrete poop cubes — Phys.org (University of Tasmania)',
    confidence: 'high',
  },
  {
    key: 'fact.mossSeemsToBeAParticularDelicacy',
    text: EN['fact.mossSeemsToBeAParticularDelicacy'],
    source:
      'https://nre.tas.gov.au/wildlife-management/fauna-of-tasmania/mammals/possums-kangaroos-and-wombats/wombat',
    sourceTitle: 'Bare-nosed Wombat — Department of Natural Resources and Environment Tasmania',
    confidence: 'high',
  },
  {
    key: 'fact.matthewFlindersSpelledItWhombatAndUsed',
    text: EN['fact.matthewFlindersSpelledItWhombatAndUsed'],
    source: 'https://www.paradisec.org.au/blog/2009/01/the-wombat-trail/',
    sourceTitle: 'The ‘wombat’ trail — PARADISEC (David Nash)',
    confidence: 'high',
  },
  {
    key: 'fact.aMainlandBareNosedWombatAveragesAbout',
    text: EN['fact.aMainlandBareNosedWombatAveragesAbout'],
    source: 'https://australian.museum/learn/animals/mammals/common-wombat/',
    sourceTitle: 'Bare-nosed Wombat — Australian Museum',
    confidence: 'high',
  },
  {
    key: 'fact.northernHairyNosedWombatsCanSleepUp',
    text: EN['fact.northernHairyNosedWombatsCanSleepUp'],
    source:
      'https://www.qld.gov.au/environment/plants-animals/conservation/threatened-species/featured-projects/northern-hairy-nosed-wombat',
    sourceTitle: 'Northern hairy-nosed wombat — Queensland Government',
    confidence: 'high',
  },
  {
    key: 'fact.wombatCallsIncludeGrowlsHissesAndA',
    text: EN['fact.wombatCallsIncludeGrowlsHissesAndA'],
    source: 'https://australian.museum/learn/animals/mammals/common-wombat/',
    sourceTitle: 'Bare-nosed Wombat — Australian Museum',
    confidence: 'high',
  },
  {
    key: 'fact.theBiggestNorthernHairyNosedWombatBurrow',
    text: EN['fact.theBiggestNorthernHairyNosedWombatBurrow'],
    source: 'https://www.australianwildlife.org/animals/northern-hairy-nosed-wombat',
    sourceTitle: 'Northern Hairy-nosed Wombat — Australian Wildlife Conservancy',
    confidence: 'high',
  },
  {
    key: 'fact.howToMakeACubePartsOf',
    text: EN['fact.howToMakeACubePartsOf'],
    source: 'https://hu.gatech.edu/wp-content/uploads/2021/01/Hu21-wombat.pdf',
    sourceTitle:
      'Yang et al., “Intestines of non-uniform stiffness mold the corners of wombat feces”, Soft Matter 17 (2021) 475–488',
    confidence: 'high',
  },
  {
    key: 'fact.rossettiNamedHisWombatTopAfterHis',
    text: EN['fact.rossettiNamedHisWombatTopAfterHis'],
    source:
      'https://publicdomainreview.org/essay/o-uommibatto-how-the-pre-raphaelites-became-obsessed-with-the-wombat/',
    sourceTitle:
      '“O Uommibatto”: How the Pre-Raphaelites Became Obsessed with the Wombat — The Public Domain Review (Angus Trumble)',
    confidence: 'high',
  },
  {
    key: 'fact.aBareNosedWombatJoeySpendsTo',
    text: EN['fact.aBareNosedWombatJoeySpendsTo'],
    source: 'https://australian.museum/learn/animals/mammals/common-wombat/',
    sourceTitle: 'Bare-nosed Wombat — Australian Museum',
    confidence: 'high',
  },
  {
    key: 'fact.wombatsAreEnergyMisersInTheDry',
    text: EN['fact.wombatsAreEnergyMisersInTheDry'],
    source: 'https://europepmc.org/abstract/MED/12883985',
    sourceTitle:
      'Evans, Green & Newgrain, “The field energetics and water fluxes of free-living wombats”, Oecologia 137 (2003) 171–180',
    confidence: 'high',
  },
  {
    key: 'fact.aKmDingoProofFenceWentUp',
    text: EN['fact.aKmDingoProofFenceWentUp'],
    source: 'https://www.australianwildlife.org/animals/northern-hairy-nosed-wombat',
    sourceTitle: 'Northern Hairy-nosed Wombat — Australian Wildlife Conservancy',
    confidence: 'high',
  },
  {
    key: 'fact.wombatsRubAgainstLogsSoOftenThat',
    text: EN['fact.wombatsRubAgainstLogsSoOftenThat'],
    source:
      'https://nre.tas.gov.au/wildlife-management/fauna-of-tasmania/mammals/possums-kangaroos-and-wombats/wombat',
    sourceTitle: 'Bare-nosed Wombat — Department of Natural Resources and Environment Tasmania',
    confidence: 'high',
  },
  {
    key: 'fact.wombatsLeaveTheirCubesOnRocksLogs',
    text: EN['fact.wombatsLeaveTheirCubesOnRocksLogs'],
    source: 'https://hu.gatech.edu/wp-content/uploads/2021/01/Hu21-wombat.pdf',
    sourceTitle:
      'Yang et al., “Intestines of non-uniform stiffness mold the corners of wombat feces”, Soft Matter 17 (2021) 475–488',
    confidence: 'high',
  },
  {
    key: 'fact.tasmaniasWombatsAreTheirOwnSubspeciesVombatus',
    text: EN['fact.tasmaniasWombatsAreTheirOwnSubspeciesVombatus'],
    source:
      'https://nre.tas.gov.au/wildlife-management/fauna-of-tasmania/mammals/possums-kangaroos-and-wombats/wombat',
    sourceTitle: 'Bare-nosed Wombat — Department of Natural Resources and Environment Tasmania',
    confidence: 'high',
  },
  {
    key: 'fact.hairyNosedWombatsInSemiAridCountry',
    text: EN['fact.hairyNosedWombatsInSemiAridCountry'],
    source: 'https://europepmc.org/abstract/MED/12883985',
    sourceTitle:
      'Evans, Green & Newgrain, “The field energetics and water fluxes of free-living wombats”, Oecologia 137 (2003) 171–180',
    confidence: 'high',
  },
  {
    key: 'fact.anExtinctRelativeDiprotodonWasTheLargest',
    text: EN['fact.anExtinctRelativeDiprotodonWasTheLargest'],
    source: 'https://australian.museum/learn/australia-over-time/extinct-animals/diprotodon-optatum/',
    sourceTitle: 'Diprotodon optatum — Australian Museum',
    confidence: 'high',
  },
  {
    key: 'fact.inWinterBareNosedWombatsStayActive',
    text: EN['fact.inWinterBareNosedWombatsStayActive'],
    source: 'https://australian.museum/learn/animals/mammals/common-wombat/',
    sourceTitle: 'Bare-nosed Wombat — Australian Museum',
    confidence: 'high',
  },
  {
    key: 'fact.southernHairyNosedWombatsLinkTheirBurrows',
    text: EN['fact.southernHairyNosedWombatsLinkTheirBurrows'],
    source: 'https://www.australianwildlife.org/animals/southern-hairy-nosed-wombat',
    sourceTitle: 'Southern Hairy-nosed Wombat — Australian Wildlife Conservancy',
    confidence: 'high',
  },
  {
    key: 'fact.theTeamThatWorkedOutHowWombats',
    text: EN['fact.theTeamThatWorkedOutHowWombats'],
    source: 'https://phys.org/news/2021-02-wombats-excrete-poop-cubes.html',
    sourceTitle: 'Researchers discover how wombats excrete poop cubes — Phys.org (University of Tasmania)',
    confidence: 'high',
  },
  {
    key: 'fact.inTheNorthernHairyNosedWombatBecame',
    text: EN['fact.inTheNorthernHairyNosedWombatBecame'],
    source: 'https://theconversation.com/australian-endangered-species-northern-hairy-nosed-wombat-13148',
    sourceTitle: 'Australian endangered species: Northern Hairy-nosed Wombat — The Conversation',
    confidence: 'high',
  },
  {
    key: 'fact.aBareNosedWombatBurrowCanBe',
    text: EN['fact.aBareNosedWombatBurrowCanBe'],
    source:
      'https://nre.tas.gov.au/wildlife-management/fauna-of-tasmania/mammals/possums-kangaroos-and-wombats/wombat',
    sourceTitle: 'Bare-nosed Wombat — Department of Natural Resources and Environment Tasmania',
    confidence: 'high',
  },
  {
    key: 'fact.rossettiOftenMetFriendsAtTheWombats',
    text: EN['fact.rossettiOftenMetFriendsAtTheWombats'],
    source:
      'https://publicdomainreview.org/essay/o-uommibatto-how-the-pre-raphaelites-became-obsessed-with-the-wombat/',
    sourceTitle:
      '“O Uommibatto”: How the Pre-Raphaelites Became Obsessed with the Wombat — The Public Domain Review (Angus Trumble)',
    confidence: 'high',
  },
  {
    key: 'fact.aWombatsIncisorsSharpenThemselvesHardEnamel',
    text: EN['fact.aWombatsIncisorsSharpenThemselvesHardEnamel'],
    source: 'https://www.australianwildlife.org/animals/northern-hairy-nosed-wombat',
    sourceTitle: 'Northern Hairy-nosed Wombat — Australian Wildlife Conservancy',
    confidence: 'high',
  },
  {
    key: 'fact.afterTheBlackSummerFiresCamerasAt',
    text: EN['fact.afterTheBlackSummerFiresCamerasAt'],
    source:
      'https://wwf.org.au/news/2024/new-study-wombat-burrows-provide-critical-shelter-for-many-species-following/',
    sourceTitle:
      'New study: wombat burrows provide critical shelter for many species following wildfire — WWF-Australia',
    confidence: 'high',
  },
  {
    key: 'fact.theVictorianTownOfDaylesfordWasSurveyed',
    text: EN['fact.theVictorianTownOfDaylesfordWasSurveyed'],
    source: 'https://www.victorianplaces.com.au/daylesford',
    sourceTitle: 'Daylesford — Victorian Places',
    confidence: 'high',
  },
  {
    key: 'fact.wainAWombatAtSatsukiyamaZooIn',
    text: EN['fact.wainAWombatAtSatsukiyamaZooIn'],
    source:
      'https://www.guinnessworldrecords.com/news/2024/2/oldest-wombat-ever-wain-is-now-34-years-old-764747',
    sourceTitle: 'Oldest wombat ever, Wain, is now 34 years old — Guinness World Records',
    confidence: 'high',
  },
  {
    key: 'fact.wainTheOldestWombatEverInA',
    text: EN['fact.wainTheOldestWombatEverInA'],
    source:
      'https://www.guinnessworldrecords.com/news/2024/2/oldest-wombat-ever-wain-is-now-34-years-old-764747',
    sourceTitle: 'Oldest wombat ever, Wain, is now 34 years old — Guinness World Records',
    confidence: 'high',
  },
  {
    key: 'fact.northernHairyNosedWombatsHaveTheirSecond',
    text: EN['fact.northernHairyNosedWombatsHaveTheirSecond'],
    source: 'https://www.australianwildlife.org/animals/northern-hairy-nosed-wombat',
    sourceTitle: 'Northern Hairy-nosed Wombat — Australian Wildlife Conservancy',
    confidence: 'high',
  },
  {
    key: 'fact.aWombatsIntestineIsToMetresLong',
    text: EN['fact.aWombatsIntestineIsToMetresLong'],
    source: 'https://hu.gatech.edu/wp-content/uploads/2021/01/Hu21-wombat.pdf',
    sourceTitle:
      'Yang et al., “Intestines of non-uniform stiffness mold the corners of wombat feces”, Soft Matter 17 (2021) 475–488',
    confidence: 'high',
  },
  {
    key: 'fact.longTermSurveysSuggestBareNosedWombat',
    text: EN['fact.longTermSurveysSuggestBareNosedWombat'],
    source:
      'https://nre.tas.gov.au/wildlife-management/fauna-of-tasmania/mammals/possums-kangaroos-and-wombats/wombat',
    sourceTitle: 'Bare-nosed Wombat — Department of Natural Resources and Environment Tasmania',
    confidence: 'high',
  },
  {
    key: 'fact.theSouthernHairyNosedWombatTheSmallest',
    text: EN['fact.theSouthernHairyNosedWombatTheSmallest'],
    source: 'https://www.environment.sa.gov.au/goodliving/posts/2018/10/wombat-facts',
    sourceTitle: '10 things you might not know about wombats — Government of South Australia',
    confidence: 'high',
  },
  {
    key: 'fact.mukupirnaAWombatRelativeFromAboutMillion',
    text: EN['fact.mukupirnaAWombatRelativeFromAboutMillion'],
    source:
      'https://theconversation.com/meet-the-giant-wombat-relative-that-scratched-out-a-living-in-australia-25-million-years-ago-141296',
    sourceTitle:
      'Meet the giant wombat relative that scratched out a living in Australia 25 million years ago — The Conversation',
    confidence: 'high',
  },
  {
    key: 'fact.inAThirdNorthernHairyNosedWombat',
    text: EN['fact.inAThirdNorthernHairyNosedWombat'],
    source: 'https://statements.qld.gov.au/statements/100509',
    sourceTitle:
      'Critically endangered wombats explore new home — Queensland Ministerial Media Statements (6 June 2024)',
    confidence: 'high',
  },
  {
    key: 'fact.northernHairyNosedWombatJoeysUsuallyStay',
    text: EN['fact.northernHairyNosedWombatJoeysUsuallyStay'],
    source: 'https://www.australianwildlife.org/animals/northern-hairy-nosed-wombat',
    sourceTitle: 'Northern Hairy-nosed Wombat — Australian Wildlife Conservancy',
    confidence: 'high',
  },
  {
    key: 'fact.whenThreatenedAWombatCanDiveInto',
    text: EN['fact.whenThreatenedAWombatCanDiveInto'],
    source:
      'https://www.australiangeographic.com.au/nature-wildlife/2020/11/wombat-bums-theres-more-than-meets-the-eye/',
    sourceTitle: 'Wombat bums: there’s more than meets the eye — Australian Geographic',
    confidence: 'medium',
  },
  {
    key: 'fact.bareNosedWombatsLiveUpToAbout',
    text: EN['fact.bareNosedWombatsLiveUpToAbout'],
    source: 'https://australian.museum/learn/animals/mammals/common-wombat/',
    sourceTitle: 'Bare-nosed Wombat — Australian Museum',
    confidence: 'high',
  },
  {
    key: 'fact.phascolonusGigasAnIceAgeGiantWombat',
    text: EN['fact.phascolonusGigasAnIceAgeGiantWombat'],
    source: 'https://www.samuseum.sa.gov.au/media/phascolonus-gigas',
    sourceTitle: 'It’s a wombat, but not like you know it… — South Australian Museum',
    confidence: 'medium',
  },
  {
    key: 'fact.onTheTvSeriesACountryPractice',
    text: EN['fact.onTheTvSeriesACountryPractice'],
    source: 'https://www.environment.sa.gov.au/goodliving/posts/2018/10/wombat-facts',
    sourceTitle: '10 things you might not know about wombats — Government of South Australia',
    confidence: 'medium',
  },
];
