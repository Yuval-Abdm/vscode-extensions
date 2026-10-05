<?php
include $_SERVER['DOCUMENT_ROOT'] . '/rp_appInit.php';
extract($_POST);
echo $nom;
if (rand(0, 1)) {
    $promo = 'X';
}
echo $promo; // expect: maybe-undefined-variable
parse_ref('a1', $ref_out);
echo $ref_out;
if (isset($ref) && $ref > 0) {
    echo $ref;
}
