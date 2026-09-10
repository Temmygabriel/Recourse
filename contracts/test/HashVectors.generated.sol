// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

// GENERATED FILE — do not edit. Regenerate with:
//   node scripts/gen-hash-vectors.mjs
//
// The escrow must hash text exactly as stored. Every string below is a case
// where trimming, collapsing, or normalising would change the bytes — which
// would silently decouple this contract from the GenLayer judgment contract,
// because the two are the only implementations of this hash. See the header
// of scripts/gen-hash-vectors.mjs.
library HashVectors {
    struct StringVector {
        string name;
        string text;
        bytes32 digest;
    }

    struct RubricVector {
        string name;
        string[] rubric;
        bytes32 digest;
    }

    function stringVectors() internal pure returns (StringVector[] memory v) {
        v = new StringVector[](9);
        v[0].name = unicode"promise_simple";
        v[0].text = unicode"Deliver three illustrations.";
        v[0].digest = hex"df2a233ae2dbee7df04f174bfbc4149af71f1664a8622f564bd8e1c60829d78c";
        v[1].name = unicode"promise_trailing_newline";
        v[1].text = unicode"Deliver three illustrations.\n";
        v[1].digest = hex"556ed254183db404342cc3977bb05446250902b59d47dc233e1b483f309088f8";
        v[2].name = unicode"promise_leading_and_trailing_spaces";
        v[2].text = unicode"  Deliver three illustrations.  ";
        v[2].digest = hex"cd983a96fee4c2057ab779176629ff10b14e442553b73ebd91e027decaa51bf9";
        v[3].name = unicode"promise_internal_double_space";
        v[3].text = unicode"Deliver three  illustrations.";
        v[3].digest = hex"03ed6f9ab721c7c168f69ea786338b30da900cdf88c9324ff857d90f60e6729b";
        v[4].name = unicode"promise_unicode";
        v[4].text = unicode"Livrer 3 illustrations 🎨 — prêtes pour l'impression.";
        v[4].digest = hex"84d1b4ee15f2d519dec3301e55e2b87c99a16d649a33ac5462d4dfcfd676b2c7";
        v[5].name = unicode"promise_at_500_chars";
        v[5].text = unicode"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        v[5].digest = hex"69206a472a1f384259f2c387211f123d3cb308ec3c29c9892333814c3ebeba22";
        v[6].name = unicode"promise_tab_and_newline";
        v[6].text = unicode"Deliver\tthree\nillustrations.";
        v[6].digest = hex"1d291c6da07b7e97cc9614c3d29f8edeee8a36c2d161f8ea187d78ba9f95eab3";
        v[7].name = unicode"delivery_notes_trailing_newline";
        v[7].text = unicode"Uploaded all files.\n";
        v[7].digest = hex"1b1391e1ebd72f24dd122ab2fe179f4a75e01a9e25fab5613632d96586d90e3a";
        v[8].name = unicode"dispute_notes_simple";
        v[8].text = unicode"Only two of three were delivered.";
        v[8].digest = hex"bd814300453ebcc89605a1bff9f6e9d457e112e5641b7776ca91067c710bc904";
    }

    function rubricVectors() internal pure returns (RubricVector[] memory v) {
        v = new RubricVector[](4);
        v[0].name = unicode"rubric_three_items";
        v[0].rubric = new string[](3);
        v[0].rubric[0] = unicode"Three illustrations at 3000px";
        v[0].rubric[1] = unicode"Mobile versions";
        v[0].rubric[2] = unicode"Layered source files";
        v[0].digest = hex"de9333a259bb78b7cb0a1cfd453193106fbda15aa9f39d424dc158712c60ef4a";
        v[1].name = unicode"rubric_item_with_embedded_newline";
        v[1].rubric = new string[](2);
        v[1].rubric[0] = unicode"First line\nsecond line";
        v[1].rubric[1] = unicode"Second criterion";
        v[1].digest = hex"59809a02fa23c00dd8a33677cf2e98ffb4fbd28b461828ca1aefcd8c352b67a8";
        v[2].name = unicode"rubric_item_with_trailing_space";
        v[2].rubric = new string[](2);
        v[2].rubric[0] = unicode"Criterion with trailing space ";
        v[2].rubric[1] = unicode"Second criterion";
        v[2].digest = hex"90fea5a658d64715357636851a4e23a45e24c24bf0155b2df9d187a5aa8adf80";
        v[3].name = unicode"rubric_two_unicode_items";
        v[3].rubric = new string[](2);
        v[3].rubric[0] = unicode"Épreuve 📄";
        v[3].rubric[1] = unicode"Deuxième critère";
        v[3].digest = hex"eeca23f47d26f81d20434ae9ae911e8f0d96fa71595a4f3876cfd2bd8d6f5a96";
    }
}
