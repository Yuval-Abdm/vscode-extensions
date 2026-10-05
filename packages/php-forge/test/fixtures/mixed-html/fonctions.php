<?php
/**
  * Fonctions d'affichage
  */
function charger_clients($db){
$sql = "SELECT id, nom, solde
        FROM clients
        WHERE actif = 1";
$rows=array();
foreach($db->query($sql) as $row){
$rows[]=$row;
}
return $rows;
}

function ligne($client)
{
    $html = <<<HTML
    <tr><td>{$client['nom']}</td></tr>
    HTML;
    return $html; // fin
}
